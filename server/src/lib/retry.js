import { AppError, CODES, clientAborted, providerTimeout } from './errors.js';

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(clientAborted());
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(clientAborted());
      },
      { once: true },
    );
  });
}

/**
 * Run `fn(signal)` with a deadline. The signal also fires when `parentSignal` aborts
 * (client disconnected), and is passed to the SDK so the HTTP call is actually cancelled.
 */
export async function withTimeout(fn, ms, { provider = 'The AI service', parentSignal } = {}) {
  if (parentSignal?.aborted) throw clientAborted();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeout.signal]) : timeout.signal;
  try {
    return await fn(signal);
  } catch (err) {
    if (parentSignal?.aborted) throw clientAborted();
    if (timeout.signal.aborted) throw providerTimeout(provider, Math.round(ms / 1000), err);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Retry retryable AppErrors with exponential backoff, honouring the provider's retryAfterMs.
 * Non-retryable errors (quota exhausted, auth, bad request) are re-thrown immediately, as is a
 * provider asking us to wait longer than `maxWaitMs` (better to fall back than to stall the user).
 */
export async function withBackoff(fn, { attempts = 3, baseMs = 1000, maxWaitMs = 20_000, onRetry, signal, sleepFn = sleep } = {}) {
  for (let i = 0; ; i++) {
    try {
      return await fn(i);
    } catch (err) {
      const retryable = err instanceof AppError && err.retryable && err.code !== CODES.CLIENT_ABORTED;
      if (!retryable || i >= attempts - 1) throw err;
      if (err.retryAfterMs && err.retryAfterMs > maxWaitMs) throw err;
      const wait = err.retryAfterMs ?? baseMs * 2 ** i + Math.floor(Math.random() * 250);
      onRetry?.(err, { attempt: i + 2, of: attempts, waitMs: wait });
      await sleepFn(wait, signal);
    }
  }
}
