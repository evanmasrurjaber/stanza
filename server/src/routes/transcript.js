import { Router } from 'express';
import { invalidInput } from '../lib/errors.js';
import { transcriptUpload } from '../middleware/upload.js';
import { ingestTranscriptText } from '../transcript/segmenter.js';
import { TranscriptBody } from '../schemas/index.js';

/** POST /api/transcript — JSON { text } or multipart field "file" (.txt/.srt/.vtt). */
export function transcriptRouter({ config }) {
  const r = Router();
  r.post('/', transcriptUpload(config), (req, res) => {
    let text;
    if (req.file) {
      text = req.file.buffer.toString('utf8');
      if (text.includes('\u0000')) throw invalidInput('That file does not look like plain text.');
    } else {
      text = TranscriptBody.parse(req.body ?? {}).text;
    }
    const { segments, hasTimestamps, source, words, durationSec } = ingestTranscriptText(text, {
      maxChars: config.limits.transcriptChars,
    });
    res.json({ segments, hasTimestamps, source, words, durationSec });
  });
  return r;
}
