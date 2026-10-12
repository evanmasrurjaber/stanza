import path from 'node:path';
import { fileTypeFromFile } from 'file-type';
import { unsupportedFormat } from '../lib/errors.js';

// file-type's detected extension → formats we accept (m4a is often detected as mp4 container).
const ACCEPTED = new Set(['mp3', 'm4a', 'mp4', 'wav', 'ogg', 'oga', 'opus', 'webm', 'flac', 'aac']);

/**
 * Check the file's real content (magic bytes) instead of trusting the extension or browser MIME type.
 */
export async function assertAudioFile(filePath, originalName) {
  const detected = await fileTypeFromFile(filePath);
  const claimed = path.extname(originalName ?? '').slice(1).toLowerCase();
  if (!detected || !ACCEPTED.has(detected.ext)) {
    const what = detected ? `a .${detected.ext} file (${detected.mime})` : 'not a recognised audio format';
    throw unsupportedFormat(`"${originalName}" is named .${claimed} but its contents are ${what}. Please upload a real audio file.`);
  }
  return detected;
}
