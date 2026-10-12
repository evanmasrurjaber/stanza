import { z } from 'zod';

const csv = z
  .string()
  .default('')
  .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean));

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  GEMINI_API_KEY: z.string().default(''),
  GEMINI_MODEL: z.string().default('gemini-3-flash-preview'),
  GROQ_API_KEY: z.string().default(''),
  GROQ_MAIN_MODEL: z.string().default('openai/gpt-oss-120b'),
  GROQ_SMALL_MODEL: z.string().default('openai/gpt-oss-20b'),
  GROQ_WHISPER_MODEL: z.string().default('whisper-large-v3-turbo'),

  LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
  MAX_TRANSCRIPT_CHARS: z.coerce.number().int().positive().default(200_000),
  MAX_AUDIO_MB: z.coerce.number().positive().default(200),
  MAX_AUDIO_SECONDS: z.coerce.number().positive().default(7200),
  AUDIO_BITRATE: z.string().regex(/^\d+k$/).default('24k'),
  RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(5),
  QUOTE_MATCH_THRESHOLD: z.coerce.number().min(0.5).max(1).default(0.9),

  ALLOWED_ORIGINS: csv,
});

/**
 * Parse and freeze configuration. Throws with a readable message on invalid env.
 * In production, missing API keys are fatal; in dev/test they only disable that provider.
 */
export function loadConfig(env = process.env) {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === 'production') {
    const missing = ['GEMINI_API_KEY', 'GROQ_API_KEY'].filter((k) => !c[k]);
    if (missing.length) throw new Error(`Missing required env vars: ${missing.join(', ')}`);
    if (!c.ALLOWED_ORIGINS.length) throw new Error('ALLOWED_ORIGINS must be set in production');
  }

  return Object.freeze({
    port: c.PORT,
    env: c.NODE_ENV,
    gemini: { apiKey: c.GEMINI_API_KEY, model: c.GEMINI_MODEL },
    groq: {
      apiKey: c.GROQ_API_KEY,
      mainModel: c.GROQ_MAIN_MODEL,
      smallModel: c.GROQ_SMALL_MODEL,
      whisperModel: c.GROQ_WHISPER_MODEL,
    },
    llmTimeoutMs: c.LLM_TIMEOUT_MS,
    limits: {
      transcriptChars: c.MAX_TRANSCRIPT_CHARS,
      audioBytes: Math.round(c.MAX_AUDIO_MB * 1024 * 1024),
      audioSeconds: c.MAX_AUDIO_SECONDS,
      // Groq free tier caps a single transcription upload at 25 MB; keep a margin.
      compressedAudioBytes: 24 * 1024 * 1024,
      // Below this chunk length, stream-copy splitting would make too many requests; re-encode instead.
      copyChunkMinSeconds: 120,
      audioExtensions: ['mp3', 'm4a', 'wav', 'ogg', 'webm', 'flac'],
      transcriptExtensions: ['txt', 'srt', 'vtt'],
    },
    audioBitrate: c.AUDIO_BITRATE,
    rateLimitPerMin: c.RATE_LIMIT_PER_MIN,
    quoteMatchThreshold: c.QUOTE_MATCH_THRESHOLD,
    // Local Vite dev server is allowed by default outside production.
    allowedOrigins: c.ALLOWED_ORIGINS.length || c.NODE_ENV === 'production' ? c.ALLOWED_ORIGINS : ['http://localhost:5173'],
  });
}
