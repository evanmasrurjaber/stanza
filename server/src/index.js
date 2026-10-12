import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { createProviders } from './llm/providers.js';
import { sweepUploads } from './middleware/upload.js';
import { logger } from './lib/logger.js';

let config;
try {
  config = loadConfig();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const providers = createProviders(config);
for (const [slot, p] of Object.entries(providers)) {
  if (!p) logger.warn(`provider slot "${slot}" is not configured (missing API key)`);
}

await sweepUploads();
setInterval(sweepUploads, 30 * 60_000).unref();

const app = createApp({ config, providers });
const server = app.listen(config.port, () => {
  logger.info('server listening', {
    port: config.port,
    env: config.env,
    providers: Object.fromEntries(Object.entries(providers).map(([k, p]) => [k, p ? `${p.name} (${p.model})` : null])),
    allowedOrigins: config.allowedOrigins,
  });
});

// Long audio uploads + transcription can legitimately take several minutes.
server.requestTimeout = 15 * 60_000;
server.headersTimeout = 60_000;
// Render's proxy keeps connections alive; stay above its idle timeout.
server.keepAliveTimeout = 65_000;

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    logger.info('shutting down', { signal: sig });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
