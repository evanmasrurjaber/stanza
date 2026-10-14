import fs from 'node:fs';
import Groq from 'groq-sdk';
import {
  modelOutputInvalid,
  providerAuth,
  providerQuotaExhausted,
  providerRateLimited,
  providerRejected,
  providerTimeout,
  providerUnavailable,
} from '../lib/errors.js';

const GROQ = 'Groq';
const GROQ_WHISPER = 'Groq Whisper';

// Per-minute waits are short; a longer retry-after means an hourly/daily bucket is empty.
const MAX_SHORT_WAIT_MS = 60_000;

function client(apiKey, timeoutMs) {
  // SDK default is 2 retries; our retry layer decides instead.
  return new Groq({ apiKey, maxRetries: 0, timeout: timeoutMs });
}

/** Groq chat model adapter (strict JSON-schema mode). */
export function createGroqChatProvider({ apiKey, model, timeoutMs, maxInputTokens = null, reasoningEffort = 'low' }) {
  const groq = client(apiKey, timeoutMs);
  return {
    name: GROQ,
    model,
    maxInputTokens,
    async generateJson({ system, user, jsonSchema, schemaName = 'result', signal, temperature = 0.3 }) {
      let res;
      try {
        res = await groq.chat.completions.create(
          {
            model,
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            response_format: {
              type: 'json_schema',
              json_schema: { name: schemaName, schema: jsonSchema, strict: true },
            },
            reasoning_effort: reasoningEffort,
            temperature,
          },
          { signal },
        );
      } catch (err) {
        if (signal?.aborted) throw err;
        throw mapGroqError(err, GROQ);
      }
      const choice = res.choices?.[0];
      if (!choice?.message?.content) {
        throw modelOutputInvalid(GROQ, `${GROQ} returned an empty answer (finish reason: ${choice?.finish_reason ?? 'unknown'}).`);
      }
      return choice.message.content;
    },
  };
}

/** Groq Whisper adapter. Returns verbose_json segments with real start/end times. */
export function createGroqWhisperProvider({ apiKey, model, timeoutMs }) {
  const groq = client(apiKey, timeoutMs);
  return {
    name: GROQ_WHISPER,
    model,
    async transcribe(filePath, { signal } = {}) {
      try {
        const res = await groq.audio.transcriptions.create(
          {
            file: fs.createReadStream(filePath),
            model,
            response_format: 'verbose_json',
            timestamp_granularities: ['segment'],
            temperature: 0,
          },
          { signal },
        );
        return { text: res.text, segments: res.segments ?? [], duration: res.duration ?? null, language: res.language ?? null };
      } catch (err) {
        if (signal?.aborted) throw err;
        throw mapGroqError(err, GROQ_WHISPER);
      }
    },
  };
}

export function mapGroqError(err, provider) {
  const status = err?.status;
  if (err?.name === 'APIConnectionTimeoutError') return providerTimeout(provider, null, err);
  if (err?.name === 'APIConnectionError') return providerUnavailable(provider, 'could not connect', err);
  if (status === 429) {
    const header = err.headers?.get?.('retry-after');
    const retryAfterMs = header ? Math.ceil(Number(header) * 1000) : null;
    if (retryAfterMs && retryAfterMs > MAX_SHORT_WAIT_MS) {
      const mins = Math.ceil(retryAfterMs / 60_000);
      return providerQuotaExhausted(provider, `free quota resets in about ${mins} min`, err);
    }
    return providerRateLimited(provider, retryAfterMs, err);
  }
  // 413: request exceeds the tokens-per-minute budget (or file size) for this model on the free tier.
  if (status === 413) return providerRejected(provider, 'the input is too large for its free tier', err);
  if (status === 401 || status === 403) return providerAuth(provider, err);
  if (status === 400) return providerRejected(provider, 'invalid request', err);
  if (status >= 500) return providerUnavailable(provider, `HTTP ${status}`, err);
  return providerUnavailable(provider, 'network error', err);
}
