import { Router } from 'express';
import { audioUpload } from '../middleware/upload.js';
import { streamable } from '../lib/stream.js';
import { invalidInput } from '../lib/errors.js';
import { transcribeAudio } from '../pipeline/transcribe.js';

/**
 * POST /api/transcribe — multipart field "audio".
 * The upload itself is received before streaming starts, so upload errors (size, extension)
 * come back as normal JSON errors; upload progress is tracked in the browser.
 */
export function transcribeRouter({ config, providers }) {
  const r = Router();
  r.post(
    '/',
    audioUpload(config),
    streamable(
      ({ req, progress, signal }) => {
        if (!req.file) throw invalidInput('No audio file was received. Send it in the "audio" form field.');
        return transcribeAudio({ file: req.file, config, providers, progress, signal });
      },
      { config },
    ),
  );
  return r;
}
