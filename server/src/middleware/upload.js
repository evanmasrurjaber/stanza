import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import { unsupportedFormat } from '../lib/errors.js';

export const UPLOAD_DIR = path.join(os.tmpdir(), 'stanza-uploads');

const extOf = (name) => path.extname(name ?? '').slice(1).toLowerCase();

const extensionFilter = (allowed, kind) => (_req, file, cb) => {
  const ext = extOf(file.originalname);
  if (allowed.includes(ext)) return cb(null, true);
  cb(unsupportedFormat(`Unsupported ${kind} file ".${ext || '?'}". Supported: ${allowed.join(', ')}.`));
};

/** Small text files (.txt/.srt/.vtt) are held in memory. */
export function transcriptUpload(config) {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.limits.transcriptChars * 4, files: 1 },
    fileFilter: extensionFilter(config.limits.transcriptExtensions, 'transcript'),
  }).single('file');
}

/** Audio goes to disk under a random name; the route is responsible for deleting it. */
export function audioUpload(config) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  return multer({
    storage: multer.diskStorage({
      destination: UPLOAD_DIR,
      filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.${extOf(file.originalname)}`),
    }),
    limits: { fileSize: config.limits.audioBytes, files: 1 },
    fileFilter: extensionFilter(config.limits.audioExtensions, 'audio'),
  }).single('audio');
}

/** Remove leftovers from crashed requests (Render's disk is ephemeral, but long-lived instances still accumulate). */
export async function sweepUploads(maxAgeMs = 60 * 60 * 1000) {
  try {
    const now = Date.now();
    for (const name of await fs.promises.readdir(UPLOAD_DIR)) {
      const p = path.join(UPLOAD_DIR, name);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && now - st.mtimeMs > maxAgeMs) await fs.promises.rm(p, { force: true });
    }
  } catch {
    /* directory may not exist yet */
  }
}
