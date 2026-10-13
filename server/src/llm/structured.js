import { AppError, CODES, allProvidersFailed, modelOutputInvalid, noProviderConfigured } from '../lib/errors.js';
import { withBackoff, withTimeout } from '../lib/retry.js';
import { logger } from '../lib/logger.js';
import { createProgress } from '../lib/progress.js';
import { toStrictJsonSchema } from './strictSchema.js';

export const estimateTokens = (...texts) => Math.ceil(texts.reduce((n, t) => n + (t?.length ?? 0), 0) / 4);

// After these, trying the next provider in the chain makes sense.
const canFallBack = (err) => err instanceof AppError && (err.category === 'provider' || err.code === CODES.PROVIDER_AUTH);

/**
 * Ask a chain of providers for JSON matching `schema`, then run domain validation.
 *
 * Per provider:
 *   1. call with timeout + backoff on rate limits / transient errors
 *   2. JSON.parse → Zod → validate(data)
 *   3. if validation fails: one repair attempt with the error list appended
 * If a provider fails or its output stays invalid, move to the next provider
 * (skipping any whose input budget is too small for this prompt).
 *
 * `validate(data)` returns { value, errors }: value === null means "reject and repair";
 * a non-null value with errors means "accept, these are warnings".
 *
 * Retries, repairs and fallbacks are reported to the user through `progress.notice`.
 */
export async function generateStructured({
  task,
  system,
  user,
  schema,
  validate = (data) => ({ value: data, errors: [] }),
  providers,
  timeoutMs,
  temperature,
  progress = createProgress(),
  signal,
  backoff = {},
  // Optional: (maxUserTokens) => a shorter user prompt for providers with a small input budget
  // (Groq's free tier). Returns null when it cannot fit. Without it, such providers are skipped.
  shrink = null,
}) {
  const chain = providers.filter(Boolean);
  if (!chain.length) throw noProviderConfigured(task);

  const jsonSchema = toStrictJsonSchema(schema);
  const tokens = estimateTokens(system, user);
  const attempts = [];

  for (let i = 0; i < chain.length; i++) {
    const provider = chain[i];
    const next = chain[i + 1];
    let prompt = user;
    if (provider.maxInputTokens && tokens > provider.maxInputTokens) {
      const shorter = shrink ? shrink(provider.maxInputTokens - estimateTokens(system)) : null;
      if (!shorter || estimateTokens(system, shorter) > provider.maxInputTokens) {
        attempts.push({
          provider: provider.name,
          code: 'SKIPPED_INPUT_TOO_LARGE',
          message: `Input (~${tokens.toLocaleString('en-US')} tokens) exceeds ${provider.name}'s free-tier budget (~${provider.maxInputTokens.toLocaleString('en-US')} tokens).`,
        });
        logger.warn('provider skipped: input too large', { task, provider: provider.name, tokens });
        continue;
      }
      prompt = shorter;
      logger.warn('provider given a shortened transcript', { task, provider: provider.name, tokens, shortenedTokens: estimateTokens(system, shorter) });
      progress.notice(`${provider.name} has a small free input limit, so it is working from a shortened transcript; the result may be less complete.`, {
        level: 'warn',
        provider: provider.name,
      });
    }
    try {
      const out = await runWithRepair({ task, provider, system, user: prompt, schema, jsonSchema, validate, timeoutMs, temperature, backoff, progress, signal });
      return { ...out, provider: provider.name, model: provider.model };
    } catch (err) {
      if (!canFallBack(err)) throw err;
      attempts.push({ provider: provider.name, code: err.code, message: err.message });
      logger.warn('provider failed', { task, provider: provider.name, code: err.code, message: err.message });
      if (next) {
        const nextFits = !next.maxInputTokens || tokens <= next.maxInputTokens || Boolean(shrink);
        progress.notice(
          nextFits
            ? `${err.message} Switching to the backup provider (${next.name})…`
            : `${err.message} The backup provider (${next.name}) can't take an input this long.`,
          { level: 'warn', provider: provider.name },
        );
      }
      // With a single provider, its own error is the clearest thing to report.
      if (chain.length === 1) throw err;
    }
  }

  throw summarizeFailure(attempts);
}

function summarizeFailure(attempts) {
  const failures = attempts.filter((a) => a.code !== 'SKIPPED_INPUT_TOO_LARGE');
  const summary = attempts.map((a) => `${a.provider}: ${a.message}`).join(' ');
  const onlyQuota = failures.length > 0 && failures.every((a) => a.code === CODES.PROVIDER_QUOTA_EXHAUSTED);
  return allProvidersFailed(`All AI providers failed. ${summary}`, attempts, { retryable: !onlyQuota });
}

async function runWithRepair({ task, provider, system, user, schema, jsonSchema, validate, timeoutMs, temperature, backoff, progress, signal }) {
  let prompt = user;
  let errors = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await withBackoff(
      () =>
        withTimeout(
          (s) => provider.generateJson({ system, user: prompt, jsonSchema, schemaName: task, signal: s, temperature }),
          timeoutMs,
          { provider: provider.name, parentSignal: signal },
        ),
      {
        ...backoff,
        signal,
        onRetry: (err, { attempt: n, of, waitMs }) => {
          logger.warn('retrying provider call', { task, provider: provider.name, code: err.code, attempt: n, waitMs });
          progress.notice(`${err.message} Retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${n} of ${of})…`, {
            level: 'warn',
            provider: provider.name,
          });
        },
      },
    );

    const checked = check(raw, schema, validate);
    if (checked.value !== null) {
      if (checked.errors.length) logger.info('accepted with warnings', { task, provider: provider.name, warnings: checked.errors });
      return { data: checked.value, warnings: checked.errors, attempts: attempt };
    }

    errors = checked.errors;
    logger.warn('model output invalid', { task, provider: provider.name, attempt, errors: errors.slice(0, 10) });
    if (attempt === 1) {
      progress.notice(
        `${provider.name}'s answer failed ${errors.length} automatic check${errors.length === 1 ? '' : 's'}. Asking it to correct the answer…`,
        { level: 'info', provider: provider.name },
      );
    }
    prompt = `${user}\n\n<previous_attempt_problems>\nYour previous answer was rejected by automatic checks:\n${errors
      .slice(0, 15)
      .map((e) => `- ${e}`)
      .join('\n')}\nReturn a corrected, complete JSON answer that fixes every problem.\n</previous_attempt_problems>`;
  }
  throw modelOutputInvalid(
    provider.name,
    `${provider.name} returned an answer that failed our quality checks twice (e.g. ${errors[0] ?? 'invalid structure'}).`,
    errors.slice(0, 15),
  );
}

function check(raw, schema, validate) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { value: null, errors: ['Response was not valid JSON.'] };
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    return { value: null, errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`) };
  }
  return validate(parsed.data);
}
