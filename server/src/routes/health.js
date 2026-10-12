import { Router } from 'express';

export function healthRouter({ config, providers }) {
  const r = Router();

  // Must stay instant and never call a provider: it is the cold-start probe.
  r.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
      ok: true,
      providers: {
        primary: Boolean(providers.primary),
        fallback: Boolean(providers.fallback),
        router: Boolean(providers.router),
        transcription: Boolean(providers.whisper),
      },
    });
  });

  r.get('/limits', (_req, res) => {
    const l = config.limits;
    res.json({
      transcript: { maxChars: l.transcriptChars, fileExtensions: l.transcriptExtensions },
      audio: {
        maxMegabytes: Math.round(l.audioBytes / 1024 / 1024),
        maxSeconds: l.audioSeconds,
        extensions: l.audioExtensions,
      },
      rateLimitPerMinute: config.rateLimitPerMin,
    });
  });

  return r;
}
