import { Router } from 'express';
import { streamable } from '../lib/stream.js';
import { ReviseBody } from '../schemas/index.js';
import { reviseResult } from '../pipeline/revise.js';

/**
 * POST /api/revise — { request | preset, result, segments }.
 * Responds with { action: 'revise', result, changed, notes, failed } or
 * { action: 'clarify', clarifyQuestion } or { action: 'reject', rejectReason }.
 */
export function reviseRouter(deps) {
  const r = Router();
  r.post(
    '/',
    streamable(
      ({ req, progress, signal }) => {
        const { request, preset, result, segments } = ReviseBody.parse(req.body ?? {});
        return reviseResult({ request, preset, result, segments, deps, progress, signal });
      },
      { config: deps.config },
    ),
  );
  return r;
}
