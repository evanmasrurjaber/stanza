import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { createLimiter } from './middleware/rateLimit.js';
import { healthRouter } from './routes/health.js';
import { transcriptRouter } from './routes/transcript.js';
import { transcribeRouter } from './routes/transcribe.js';
import { generateRouter } from './routes/generate.js';
import { reviseRouter } from './routes/revise.js';

/**
 * Build the Express app. `providers` is injected so tests can swap in fakes:
 *   { primary, fallback, router, whisper } — see llm/providers.js.
 */
export function createApp({ config, providers }) {
  const app = express();

  // Render sits behind one proxy hop; this makes req.ip (and the rate limiter) use the real client IP.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(helmet());
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.allowedOrigins.includes(origin)),
      methods: ['GET', 'POST'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '2mb' }));

  const heavy = createLimiter({ perMinute: config.rateLimitPerMin, name: 'generation' });
  const light = createLimiter({ perMinute: config.rateLimitPerMin * 6, name: 'transcript' });

  const deps = { config, providers };
  // Health is deliberately not rate limited: the frontend polls it while Render wakes up.
  app.use('/api', healthRouter(deps));
  app.use('/api/transcript', light, transcriptRouter(deps));
  app.use('/api/transcribe', heavy, transcribeRouter(deps));
  app.use('/api/generate', heavy, generateRouter(deps));
  app.use('/api/revise', heavy, reviseRouter(deps));

  app.use(notFoundHandler);
  app.use(errorHandler(config));
  return app;
}
