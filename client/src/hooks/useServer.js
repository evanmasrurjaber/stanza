import { useCallback, useEffect, useRef, useState } from 'react';
import { getJson } from '../api/client.js';

export const DEFAULT_LIMITS = {
  transcript: { maxChars: 200_000, fileExtensions: ['txt', 'srt', 'vtt'] },
  audio: { maxMegabytes: 200, maxSeconds: 7200, extensions: ['mp3', 'm4a', 'wav', 'ogg', 'webm', 'flac'] },
  rateLimitPerMinute: 5,
};

const GIVE_UP_AFTER_MS = 150_000; // Render cold starts take ~1 min; past this, call it offline but keep trying.

/**
 * Tracks whether the API is reachable. Render's free tier sleeps after 15 idle minutes and
 * needs about a minute to wake, so the first health check may hang or fail: we report
 * "waking" and poll until it answers.
 *   status: checking | waking | ready | offline
 */
export function useServer() {
  const [state, setState] = useState({ status: 'checking', wakingSince: null, providers: null, limits: DEFAULT_LIMITS });
  const [nonce, setNonce] = useState(0);
  const startedRef = useRef(Date.now());

  useEffect(() => {
    let cancelled = false;
    let timer;
    startedRef.current = Date.now();

    const check = async (first) => {
      try {
        const health = await getJson('/api/health', { timeoutMs: first ? 2500 : 8000 });
        if (cancelled) return;
        const limits = await getJson('/api/limits', { timeoutMs: 8000 }).catch(() => DEFAULT_LIMITS);
        if (!cancelled) setState({ status: 'ready', wakingSince: null, providers: health.providers, limits });
      } catch {
        if (cancelled) return;
        const elapsed = Date.now() - startedRef.current;
        setState((s) => ({
          ...s,
          status: elapsed > GIVE_UP_AFTER_MS ? 'offline' : 'waking',
          wakingSince: s.wakingSince ?? startedRef.current,
        }));
        timer = setTimeout(() => check(false), elapsed > GIVE_UP_AFTER_MS ? 10_000 : 3000);
      }
    };
    check(true);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [nonce]);

  /** Call after a request fails with a network error: the server may have gone back to sleep. */
  const recheck = useCallback(() => {
    setState((s) => ({ ...s, status: 'waking', wakingSince: Date.now() }));
    setNonce((n) => n + 1);
  }, []);

  return { ...state, recheck };
}
