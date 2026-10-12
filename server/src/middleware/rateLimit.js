import { rateLimit } from 'express-rate-limit';
import { tooManyRequests } from '../lib/errors.js';

/**
 * Per-IP limiter for our own routes. Provider quotas are shared by every visitor,
 * so one client must not be able to burn through them (OWASP API4).
 */
export function createLimiter({ perMinute, name }) {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (req, _res, next, options) => {
      const resetMs = req.rateLimit?.resetTime ? Math.max(1000, req.rateLimit.resetTime.getTime() - Date.now()) : options.windowMs;
      next(
        tooManyRequests(
          `You've made more than ${perMinute} ${name} requests in a minute (this app's own limit, to protect the shared free AI quota). Try again in ${Math.ceil(resetMs / 1000)} s.`,
          resetMs,
        ),
      );
    },
  });
}
