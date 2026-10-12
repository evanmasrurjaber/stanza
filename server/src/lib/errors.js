/**
 * Every error the API returns is an AppError. The fields are designed so the UI can tell the
 * user exactly what broke and what to do about it:
 *
 *   code        stable machine-readable identifier (see CODES below)
 *   category    whose "fault" it is:
 *                 input    – the user's file/text was rejected (fix the input)
 *                 limit    – our own per-user rate limit (wait a minute)
 *                 provider – an external AI service failed (Gemini / Groq)
 *                 server   – our server failed or is misconfigured
 *   provider    'Gemini' | 'Groq' | 'Groq Whisper' | null
 *   stage       pipeline stage where it happened (see lib/progress.js STAGES), set by the pipeline
 *   message     human-readable, safe to show as-is
 *   retryable   whether retrying the same request can succeed
 *   retryAfterMs suggested wait before retrying, when known
 *   attempts    for fallback chains: what each provider said, in order
 *
 * Internal details (stack traces, raw provider payloads) only go to server logs.
 */
export class AppError extends Error {
  constructor(
    code,
    status,
    message,
    { category = 'server', provider = null, stage = null, retryable = false, retryAfterMs = null, details = null, attempts = null, cause } = {},
  ) {
    super(message, { cause });
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.category = category;
    this.provider = provider;
    this.stage = stage;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.details = details;
    this.attempts = attempts;
  }

  /** Public JSON shape, used by both the error middleware and streamed `error` events. */
  toJSON() {
    return {
      code: this.code,
      category: this.category,
      message: this.message,
      provider: this.provider,
      stage: this.stage,
      retryable: this.retryable,
      retryAfterSeconds: this.retryAfterMs != null ? Math.ceil(this.retryAfterMs / 1000) : null,
      ...(this.details ? { details: this.details } : {}),
      ...(this.attempts ? { attempts: this.attempts } : {}),
    };
  }
}

export const CODES = Object.freeze({
  // input
  INVALID_INPUT: 'INVALID_INPUT',
  FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  UNSUPPORTED_FORMAT: 'UNSUPPORTED_FORMAT',
  AUDIO_TOO_LONG: 'AUDIO_TOO_LONG',
  AUDIO_UNREADABLE: 'AUDIO_UNREADABLE',
  NO_SPEECH: 'NO_SPEECH',
  // limit
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  // provider
  PROVIDER_RATE_LIMITED: 'PROVIDER_RATE_LIMITED',
  PROVIDER_QUOTA_EXHAUSTED: 'PROVIDER_QUOTA_EXHAUSTED',
  PROVIDER_TIMEOUT: 'PROVIDER_TIMEOUT',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  PROVIDER_REJECTED: 'PROVIDER_REJECTED',
  MODEL_OUTPUT_INVALID: 'MODEL_OUTPUT_INVALID',
  ALL_PROVIDERS_FAILED: 'ALL_PROVIDERS_FAILED',
  // server
  PROVIDER_AUTH: 'PROVIDER_AUTH',
  NO_PROVIDER_CONFIGURED: 'NO_PROVIDER_CONFIGURED',
  AUDIO_PROCESSING_FAILED: 'AUDIO_PROCESSING_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
  // client went away (never sent to anyone; used to stop work)
  CLIENT_ABORTED: 'CLIENT_ABORTED',
});

// ---------- input ----------
export const invalidInput = (message, details) =>
  new AppError(CODES.INVALID_INPUT, 400, message, { category: 'input', details });

export const fileTooLarge = (message) => new AppError(CODES.FILE_TOO_LARGE, 413, message, { category: 'input' });

export const unsupportedFormat = (message) => new AppError(CODES.UNSUPPORTED_FORMAT, 415, message, { category: 'input' });

export const audioTooLong = (message) => new AppError(CODES.AUDIO_TOO_LONG, 422, message, { category: 'input' });

export const audioUnreadable = (message, cause) =>
  new AppError(CODES.AUDIO_UNREADABLE, 422, message, { category: 'input', cause });

export const noSpeech = (message) => new AppError(CODES.NO_SPEECH, 422, message, { category: 'input' });

// ---------- limit ----------
export const tooManyRequests = (message, retryAfterMs) =>
  new AppError(CODES.TOO_MANY_REQUESTS, 429, message, { category: 'limit', retryable: true, retryAfterMs });

// ---------- provider ----------
/** Short-term (per-minute) limit at the provider. Safe to retry after a wait. */
export const providerRateLimited = (provider, retryAfterMs = null, cause) =>
  new AppError(
    CODES.PROVIDER_RATE_LIMITED,
    503,
    `${provider} is receiving too many requests right now (rate limit).${retryAfterMs ? ` It asked us to wait ${Math.ceil(retryAfterMs / 1000)} s.` : ''}`,
    { category: 'provider', provider, retryable: true, retryAfterMs, cause },
  );

/** Daily / hourly free quota exhausted. Retrying soon will not help. */
export const providerQuotaExhausted = (provider, detail, cause) =>
  new AppError(
    CODES.PROVIDER_QUOTA_EXHAUSTED,
    503,
    `${provider}'s free usage quota is used up${detail ? ` (${detail})` : ''}. Please try again later.`,
    { category: 'provider', provider, retryable: false, cause },
  );

export const providerTimeout = (provider, seconds, cause) =>
  new AppError(CODES.PROVIDER_TIMEOUT, 504, `${provider} did not respond in time${seconds ? ` (waited ${seconds} s)` : ''}.`, {
    category: 'provider',
    provider,
    retryable: true,
    cause,
  });

export const providerUnavailable = (provider, detail, cause) =>
  new AppError(CODES.PROVIDER_UNAVAILABLE, 502, `${provider} is not responding${detail ? ` (${detail})` : ''}.`, {
    category: 'provider',
    provider,
    retryable: true,
    cause,
  });

export const providerRejected = (provider, detail, cause) =>
  new AppError(CODES.PROVIDER_REJECTED, 502, `${provider} refused the request${detail ? `: ${detail}` : ''}.`, {
    category: 'provider',
    provider,
    retryable: false,
    cause,
  });

export const modelOutputInvalid = (provider, message, details) =>
  new AppError(CODES.MODEL_OUTPUT_INVALID, 502, message, { category: 'provider', provider, retryable: true, details });

export const allProvidersFailed = (message, attempts, { retryable = true, retryAfterMs = null } = {}) =>
  new AppError(CODES.ALL_PROVIDERS_FAILED, 503, message, { category: 'provider', retryable, retryAfterMs, attempts });

// ---------- server ----------
/** Our API key was rejected: an operator problem, not something the user can fix. */
export const providerAuth = (provider, cause) =>
  new AppError(
    CODES.PROVIDER_AUTH,
    500,
    `The server's ${provider} API key was rejected. This is a server configuration problem, not something wrong with your input.`,
    { category: 'server', provider, retryable: false, cause },
  );

export const noProviderConfigured = (what) =>
  new AppError(CODES.NO_PROVIDER_CONFIGURED, 500, `The server has no AI provider configured for ${what}.`, {
    category: 'server',
  });

export const audioProcessingFailed = (message, cause) =>
  new AppError(CODES.AUDIO_PROCESSING_FAILED, 500, message, { category: 'server', retryable: true, cause });

export const notFound = (message = 'Not found.') => new AppError(CODES.NOT_FOUND, 404, message, { category: 'input' });

export const internal = (cause) =>
  new AppError(CODES.INTERNAL, 500, 'Unexpected server error. Please try again; if it keeps happening, report it.', {
    category: 'server',
    retryable: true,
    cause,
  });

export const clientAborted = () => new AppError(CODES.CLIENT_ABORTED, 499, 'Client closed the request.', { category: 'input' });
