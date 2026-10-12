// Minimal structured logger: one JSON line per event, which Render's log viewer handles well.
const silent = process.env.NODE_ENV === 'test';

function write(level, msg, fields) {
  if (silent) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

export const logger = {
  info: (msg, fields = {}) => write('info', msg, fields),
  warn: (msg, fields = {}) => write('warn', msg, fields),
  error: (msg, fields = {}) => write('error', msg, fields),
};

export function errorFields(err) {
  if (!err) return {};
  return {
    err: { name: err.name, message: err.message, code: err.code, status: err.status, stack: err.stack },
    cause: err.cause ? { name: err.cause.name, message: err.cause.message, status: err.cause.status } : undefined,
  };
}
