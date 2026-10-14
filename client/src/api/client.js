/**
 * Talks to the Stanza API.
 *
 * Every failure is thrown as an ApiError with the server's error shape
 * ({ code, category, message, provider, stage, retryable, retryAfterSeconds, attempts }),
 * plus two client-only categories: "network" (no response at all) and "aborted" (user cancelled).
 */
const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');
const NDJSON = 'application/x-ndjson';

export class ApiError extends Error {
  constructor(info) {
    super(info.message);
    this.name = 'ApiError';
    Object.assign(this, { code: 'UNKNOWN', category: 'server', provider: null, stage: null, retryable: true, retryAfterSeconds: null, attempts: null, ...info });
  }
}

const aborted = () => new ApiError({ code: 'ABORTED', category: 'aborted', message: 'Cancelled.', retryable: true });

const networkError = (cause) =>
  new ApiError({
    code: 'NETWORK',
    category: 'network',
    message: "Can't reach the Stanza server. It may be waking up (free hosting sleeps when idle) or offline.",
    retryable: true,
    cause,
  });

const connectionLost = () =>
  new ApiError({
    code: 'CONNECTION_LOST',
    category: 'network',
    message: 'The connection to the server dropped before the work finished.',
    retryable: true,
  });

async function errorFromResponse(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: proxies and gateways return HTML */
  }
  if (body?.error) return new ApiError({ ...body.error, status: res.status });
  if (res.status === 502 || res.status === 503 || res.status === 504) {
    return new ApiError({
      code: 'GATEWAY',
      category: 'network',
      status: res.status,
      message: `The server is not answering (HTTP ${res.status}). It is probably still starting up.`,
      retryable: true,
    });
  }
  return new ApiError({ code: 'HTTP_' + res.status, category: 'server', status: res.status, message: `Unexpected server response (HTTP ${res.status}).` });
}

/** Feed NDJSON text chunks; calls onLine for each complete line. */
function lineSplitter(onLine) {
  let buf = '';
  return {
    push(chunk) {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    },
    flush() {
      if (buf.trim()) onLine(buf.trim());
      buf = '';
    },
  };
}

/** Route one stream event; returns { done, data } when the stream reached its result. */
function handleEvent(evt, onEvent) {
  if (evt.type === 'result') return { done: true, data: evt.data };
  if (evt.type === 'error') throw new ApiError({ ...evt.error, status: evt.status });
  onEvent?.(evt);
  return null;
}

export async function getJson(path, { signal, timeoutMs } = {}) {
  const ctrl = new AbortController();
  const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  signal?.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(API_BASE + path, { signal: ctrl.signal, cache: 'no-store' });
    if (!res.ok) throw await errorFromResponse(res);
    return await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal?.aborted) throw aborted();
    throw networkError(err);
  } finally {
    clearTimeout(timer);
  }
}

/** POST JSON or FormData; non-streaming. */
export async function postJson(path, body, { signal } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: body instanceof FormData ? undefined : { 'Content-Type': 'application/json' },
      body: body instanceof FormData ? body : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw aborted();
    throw networkError(err);
  }
  if (!res.ok) throw await errorFromResponse(res);
  return res.json();
}

/** POST JSON and read NDJSON progress events until the result (or error) line. */
export async function postStream(path, body, { onEvent, signal } = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: NDJSON },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw aborted();
    throw networkError(err);
  }
  if (!res.ok) throw await errorFromResponse(res);
  if (!(res.headers.get('content-type') ?? '').includes(NDJSON)) return res.json();

  let outcome = null;
  const split = lineSplitter((line) => {
    if (outcome) return;
    outcome = handleEvent(JSON.parse(line), onEvent);
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      split.push(decoder.decode(value, { stream: true }));
      if (outcome) break;
    }
    split.flush();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (signal?.aborted) throw aborted();
    throw connectionLost();
  }
  if (!outcome) throw signal?.aborted ? aborted() : connectionLost();
  return outcome.data;
}

/**
 * Upload audio with XMLHttpRequest (fetch has no upload progress) and read the NDJSON
 * response incrementally as it arrives.
 */
export function uploadAudio(file, { onUploadProgress, onEvent, signal } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', API_BASE + '/api/transcribe');
    xhr.setRequestHeader('Accept', NDJSON);
    let seen = 0;
    let outcome = null;
    let failed = false;
    const split = lineSplitter((line) => {
      if (outcome || failed) return;
      try {
        outcome = handleEvent(JSON.parse(line), onEvent);
      } catch (err) {
        failed = true;
        reject(err);
      }
    });
    const pump = () => {
      if (xhr.status !== 200) return;
      const text = xhr.responseText;
      split.push(text.slice(seen));
      seen = text.length;
    };

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onUploadProgress?.(e.loaded / e.total);
    };
    xhr.upload.onload = () => onUploadProgress?.(1);
    xhr.onprogress = pump;
    xhr.onload = async () => {
      if (xhr.status !== 200) {
        let body = null;
        try {
          body = JSON.parse(xhr.responseText);
        } catch {
          /* ignore */
        }
        return reject(
          body?.error
            ? new ApiError({ ...body.error, status: xhr.status })
            : await errorFromResponse(new Response(xhr.responseText, { status: xhr.status })),
        );
      }
      pump();
      split.flush();
      if (failed) return;
      if (outcome) resolve(outcome.data);
      else reject(connectionLost());
    };
    xhr.onerror = () => reject(networkError());
    xhr.onabort = () => reject(aborted());
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });

    const form = new FormData();
    form.append('audio', file);
    xhr.send(form);
  });
}
