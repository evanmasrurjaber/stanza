import multer from 'multer';
import { ZodError } from 'zod';
import { AppError, fileTooLarge, internal, invalidInput, notFound } from '../lib/errors.js';
import { logger, errorFields } from '../lib/logger.js';

export function notFoundHandler(req, _res, next) {
  next(notFound(`No route for ${req.method} ${req.path}.`));
}

/** Convert anything thrown into an AppError. Unknown errors become INTERNAL (category "server"). */
export function toAppError(err, { maxUploadBytes } = {}) {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    const details = err.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    const first = details[0];
    return invalidInput(
      first ? `Invalid request: ${first.path ? `${first.path} – ` : ''}${first.message}` : 'Invalid request.',
      details,
    );
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      const mb = maxUploadBytes ? Math.round(maxUploadBytes / 1024 / 1024) : null;
      return fileTooLarge(mb ? `The file is larger than the ${mb} MB upload limit.` : 'The file is too large.');
    }
    if (err.code === 'LIMIT_UNEXPECTED_FILE') return invalidInput(`Unexpected upload field "${err.field}".`);
    return invalidInput(`Upload problem: ${err.message}.`);
  }
  // body-parser failures
  if (err?.type === 'entity.parse.failed') return invalidInput('The request body is not valid JSON.');
  if (err?.type === 'entity.too.large') return fileTooLarge('The request body is larger than the 2 MB limit.');
  return internal(err);
}

export function errorHandler(config) {
  // Express recognises error middleware by its four parameters.
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, _next) => {
    const appErr = toAppError(err, { maxUploadBytes: config.limits.audioBytes });
    (appErr.status >= 500 ? logger.error : logger.warn)('request failed', {
      method: req.method,
      path: req.path,
      code: appErr.code,
      category: appErr.category,
      provider: appErr.provider,
      stage: appErr.stage,
      ...errorFields(appErr.status >= 500 ? (appErr.cause ?? appErr) : null),
    });

    if (res.headersSent) return res.end();
    if (appErr.retryAfterMs) res.set('Retry-After', String(Math.ceil(appErr.retryAfterMs / 1000)));
    res.status(appErr.status).json({ error: appErr.toJSON() });
  };
}
