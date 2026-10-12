import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { toStrictJsonSchema } from '../src/llm/strictSchema.js';
import { generateStructured } from '../src/llm/structured.js';
import { withBackoff, withTimeout } from '../src/lib/retry.js';
import { createProgress } from '../src/lib/progress.js';
import { providerQuotaExhausted, providerRateLimited, providerUnavailable, providerAuth } from '../src/lib/errors.js';
import { mapGeminiError } from '../src/llm/gemini.js';
import { mapGroqError } from '../src/llm/groq.js';
import { LLM_Overview, LLM_Route } from '../src/schemas/index.js';

const Schema = z.object({ answer: z.string(), note: z.string().nullable() });
const noWait = { sleepFn: async () => {} };

/** Fake provider that returns (or throws) the queued responses in order. */
function fake(name, responses, { maxInputTokens = null } = {}) {
  const queue = [...responses];
  const calls = [];
  return {
    name,
    model: `${name}-model`,
    maxInputTokens,
    calls,
    async generateJson(args) {
      calls.push(args);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'string' ? next : JSON.stringify(next);
    },
  };
}

const base = { task: 'test', system: 'sys', user: 'user', schema: Schema, timeoutMs: 1000, backoff: noWait };

describe('toStrictJsonSchema', () => {
  it('marks every object closed with all keys required (Groq strict mode)', () => {
    const json = toStrictJsonSchema(LLM_Overview);
    expect(json.$schema).toBeUndefined();
    expect(json.additionalProperties).toBe(false);
    expect(json.required).toEqual(['summary', 'themes', 'takeaways', 'chapters']);
    expect(json.properties.chapters.items.additionalProperties).toBe(false);
    expect(json.properties.chapters.items.required).toEqual(['startSegmentId', 'title', 'explanation']);
  });

  it('keeps nullable fields required', () => {
    const json = toStrictJsonSchema(LLM_Route);
    expect(json.required).toContain('clarifyQuestion');
  });
});

describe('retry helpers', () => {
  it('withBackoff retries retryable errors and reports attempts', async () => {
    const onRetry = vi.fn();
    let n = 0;
    const out = await withBackoff(
      async () => {
        if (n++ < 2) throw providerRateLimited('Gemini', 10);
        return 'ok';
      },
      { ...noWait, onRetry },
    );
    expect(out).toBe('ok');
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][1]).toMatchObject({ attempt: 2, of: 3, waitMs: 10 });
  });

  it('withBackoff does not retry quota exhaustion', async () => {
    const fn = vi.fn(async () => {
      throw providerQuotaExhausted('Gemini');
    });
    await expect(withBackoff(fn, noWait)).rejects.toMatchObject({ code: 'PROVIDER_QUOTA_EXHAUSTED' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withBackoff gives up early when the provider asks for a very long wait', async () => {
    const fn = vi.fn(async () => {
      throw providerRateLimited('Gemini', 120_000);
    });
    await expect(withBackoff(fn, noWait)).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('withTimeout produces PROVIDER_TIMEOUT naming the provider', async () => {
    const hang = (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    await expect(withTimeout(hang, 20, { provider: 'Gemini' })).rejects.toMatchObject({
      code: 'PROVIDER_TIMEOUT',
      provider: 'Gemini',
      category: 'provider',
    });
  });

  it('withTimeout reports a client disconnect as CLIENT_ABORTED, not a timeout', async () => {
    const parent = new AbortController();
    const hang = (signal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const p = withTimeout(hang, 5000, { provider: 'Gemini', parentSignal: parent.signal });
    parent.abort();
    await expect(p).rejects.toMatchObject({ code: 'CLIENT_ABORTED' });
  });
});

describe('generateStructured', () => {
  it('returns validated data and the provider used', async () => {
    const p = fake('Gemini', [{ answer: 'hi', note: null }]);
    const out = await generateStructured({ ...base, providers: [p] });
    expect(out).toMatchObject({ data: { answer: 'hi', note: null }, provider: 'Gemini', attempts: 1 });
  });

  it('repairs once with the validation errors in the prompt, and tells the user', async () => {
    const p = fake('Gemini', ['not json', { answer: 'fixed', note: null }]);
    const events = [];
    const out = await generateStructured({ ...base, providers: [p], progress: createProgress((e) => events.push(e)) });
    expect(out.attempts).toBe(2);
    expect(p.calls[1].user).toMatch(/Response was not valid JSON/);
    expect(events.some((e) => e.type === 'notice' && /failed 1 automatic check/.test(e.message))).toBe(true);
  });

  it('domain validation can reject and trigger repair', async () => {
    const p = fake('Gemini', [{ answer: 'bad', note: null }, { answer: 'good', note: null }]);
    const validate = (d) => (d.answer === 'good' ? { value: d, errors: [] } : { value: null, errors: ['answer must be good'] });
    const out = await generateStructured({ ...base, providers: [p], validate });
    expect(out.data.answer).toBe('good');
    expect(p.calls[1].user).toMatch(/answer must be good/);
  });

  it('falls back to the next provider on quota exhaustion and announces it', async () => {
    const primary = fake('Gemini', [providerQuotaExhausted('Gemini', 'daily request limit reached')]);
    const backup = fake('Groq', [{ answer: 'from groq', note: null }]);
    const events = [];
    const out = await generateStructured({ ...base, providers: [primary, backup], progress: createProgress((e) => events.push(e)) });
    expect(out.provider).toBe('Groq');
    const notice = events.find((e) => e.type === 'notice');
    expect(notice.message).toMatch(/Gemini's free usage quota is used up.*Switching to the backup provider \(Groq\)/);
  });

  it('skips a fallback whose input budget is too small and explains why', async () => {
    const primary = fake('Gemini', [providerUnavailable('Gemini', 'HTTP 503')]);
    const backup = fake('Groq', [{ answer: 'x', note: null }], { maxInputTokens: 10 });
    const err = await generateStructured({ ...base, user: 'u'.repeat(400), providers: [primary, backup], backoff: { ...noWait, attempts: 1 } }).catch((e) => e);
    expect(err.code).toBe('ALL_PROVIDERS_FAILED');
    expect(err.attempts.map((a) => a.code)).toEqual(['PROVIDER_UNAVAILABLE', 'SKIPPED_INPUT_TOO_LARGE']);
    expect(err.message).toMatch(/Gemini is not responding.*exceeds Groq's free-tier budget/);
    expect(backup.calls).toHaveLength(0);
  });

  it('reports a single provider failure directly', async () => {
    const p = fake('Groq', [providerAuth('Groq')]);
    await expect(generateStructured({ ...base, providers: [p] })).rejects.toMatchObject({ code: 'PROVIDER_AUTH', category: 'server' });
  });

  it('all quota exhausted → not retryable', async () => {
    const a = fake('Gemini', [providerQuotaExhausted('Gemini')]);
    const b = fake('Groq', [providerQuotaExhausted('Groq')]);
    await expect(generateStructured({ ...base, providers: [a, b] })).rejects.toMatchObject({ code: 'ALL_PROVIDERS_FAILED', retryable: false });
  });

  it('no providers configured is a server error', async () => {
    await expect(generateStructured({ ...base, providers: [null] })).rejects.toMatchObject({ code: 'NO_PROVIDER_CONFIGURED', category: 'server' });
  });
});

describe('provider error mapping', () => {
  it('Gemini daily quota vs per-minute limit', () => {
    expect(mapGeminiError({ status: 429, message: 'quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier' }).code).toBe('PROVIDER_QUOTA_EXHAUSTED');
    const rl = mapGeminiError({ status: 429, message: '{"retryDelay": "12s"} PerMinute' });
    expect(rl).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 12000 });
    expect(mapGeminiError({ status: 403, message: 'permission denied' }).code).toBe('PROVIDER_AUTH');
    expect(mapGeminiError({ status: 503, message: 'overloaded' }).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('Groq retry-after decides rate limit vs quota', () => {
    const h = (v) => ({ get: (k) => (k === 'retry-after' ? v : null) });
    expect(mapGroqError({ status: 429, headers: h('3') }, 'Groq')).toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 3000 });
    expect(mapGroqError({ status: 429, headers: h('3600') }, 'Groq').code).toBe('PROVIDER_QUOTA_EXHAUSTED');
    expect(mapGroqError({ name: 'APIConnectionError' }, 'Groq').code).toBe('PROVIDER_UNAVAILABLE');
  });
});
