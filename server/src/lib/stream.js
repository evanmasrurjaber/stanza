import { AppError, CODES, clientAborted } from './errors.js';
import { createProgress } from './progress.js';
import { toAppError } from '../middleware/errorHandler.js';
import { logger, errorFields } from './logger.js';

export const NDJSON = 'application/x-ndjson';
const HEARTBEAT_MS = 10_000;

const wantsStream = (req) => (req.get('accept') ?? '').includes(NDJSON) || req.query.stream === '1';

/**
 * Wrap a long-running route handler `({ req, progress, signal }) => data`.
 *
 * - Plain request: responds with JSON `data`; errors go through the error middleware.
 * - `Accept: application/x-ndjson` (or ?stream=1): responds 200 with one JSON event per line:
 *     {type:'stage'|'progress'|'notice'|'heartbeat', ..., elapsedMs}
 *     {type:'result', data}                    – final line on success
 *     {type:'error', status, error}            – final line on failure (same shape as JSON errors)
 *   Heartbeats keep proxies from closing the connection during long provider calls.
 *
 * In both modes, if the client disconnects we abort `signal` so no more provider quota is spent.
 * Errors are tagged with the stage that was running when they happened.
 */
export function streamable(handler, { config }) {
  return async (req, res, next) => {
    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) controller.abort(clientAborted());
    });

    if (!wantsStream(req)) {
      const progress = createProgress();
      try {
        res.json(await handler({ req, progress, signal: controller.signal }));
      } catch (err) {
        if (controller.signal.aborted) return; // nobody is listening
        next(tagStage(err, progress.current));
      }
      return;
    }

    const started = Date.now();
    res.status(200).set({
      'Content-Type': `${NDJSON}; charset=utf-8`,
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const write = (evt) => {
      if (!res.writableEnded && !res.destroyed) res.write(`${JSON.stringify({ ...evt, elapsedMs: Date.now() - started })}\n`);
    };
    const heartbeat = setInterval(() => write({ type: 'heartbeat' }), HEARTBEAT_MS);
    const progress = createProgress(write);

    try {
      const data = await handler({ req, progress, signal: controller.signal });
      write({ type: 'result', data });
    } catch (err) {
      const appErr = tagStage(toAppError(err, { maxUploadBytes: config.limits.audioBytes }), progress.current);
      if (appErr.code !== CODES.CLIENT_ABORTED && !controller.signal.aborted) {
        (appErr.status >= 500 ? logger.error : logger.warn)('stream request failed', {
          path: req.path,
          code: appErr.code,
          stage: appErr.stage,
          ...errorFields(appErr.status >= 500 ? (appErr.cause ?? appErr) : null),
        });
        write({ type: 'error', status: appErr.status, error: appErr.toJSON() });
      }
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  };
}

function tagStage(err, stage) {
  if (err instanceof AppError && !err.stage && stage) err.stage = stage;
  return err;
}
