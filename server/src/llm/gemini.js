import { GoogleGenAI, ApiError } from '@google/genai';
import {
  modelOutputInvalid,
  providerAuth,
  providerQuotaExhausted,
  providerRateLimited,
  providerRejected,
  providerUnavailable,
} from '../lib/errors.js';

export const GEMINI = 'Gemini';

/**
 * Gemini adapter. Exposes the provider interface used by llm/structured.js:
 *   generateJson({ system, user, jsonSchema, signal, temperature }) -> string
 */
export function createGeminiProvider({ apiKey, model }) {
  // The SDK retries 5x by default; we own retry/backoff/fallback policy, so disable it.
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });

  return {
    name: GEMINI,
    model,
    maxInputTokens: null, // ~1M context; effectively unlimited for our input caps
    async generateJson({ system, user, jsonSchema, signal, temperature = 0.3 }) {
      let res;
      try {
        res = await ai.models.generateContent({
          model,
          contents: user,
          config: {
            systemInstruction: system,
            responseMimeType: 'application/json',
            responseJsonSchema: jsonSchema,
            temperature,
            abortSignal: signal,
          },
        });
      } catch (err) {
        if (signal?.aborted) throw err; // withTimeout converts this to timeout / client-abort
        throw mapGeminiError(err);
      }
      const text = res.text;
      if (!text) {
        const reason = res.candidates?.[0]?.finishReason ?? res.promptFeedback?.blockReason ?? 'unknown';
        if (/SAFETY|BLOCK|PROHIBITED/i.test(reason)) {
          throw providerRejected(GEMINI, `its safety filter blocked this content (${reason})`);
        }
        throw modelOutputInvalid(GEMINI, `${GEMINI} returned an empty answer (reason: ${reason}).`);
      }
      return text;
    },
  };
}

/** Map a Gemini SDK error to an AppError naming `provider` (e.g. "Gemini" or "Gemini Transcribe"). */
export function mapGeminiError(err, provider = GEMINI) {
  const status = err instanceof ApiError ? err.status : err?.status;
  const msg = String(err?.message ?? '');
  if (status === 429) {
    // Quota errors carry the violated quota id, e.g. "GenerateRequestsPerDayPerProjectPerModel-FreeTier".
    if (/PerDay/i.test(msg)) return providerQuotaExhausted(provider, 'daily request limit reached', err);
    if (/RESOURCE_EXHAUSTED/i.test(msg) && !/PerMinute/i.test(msg) && /quota/i.test(msg) && !/retryDelay/i.test(msg)) {
      return providerQuotaExhausted(provider, 'quota exceeded', err);
    }
    const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(msg);
    return providerRateLimited(provider, delay ? Math.ceil(Number(delay[1]) * 1000) : null, err);
  }
  if (status === 401 || status === 403) {
    if (/location|region|country/i.test(msg)) return providerRejected(provider, 'the API is not available in the server region', err);
    return providerAuth(provider, err);
  }
  if (status === 400) return providerRejected(provider, 'invalid request', err);
  if (status === 413) return providerRejected(provider, 'the input is too large', err);
  if (status >= 500) return providerUnavailable(provider, `HTTP ${status}`, err);
  return providerUnavailable(provider, 'network error', err);
}
