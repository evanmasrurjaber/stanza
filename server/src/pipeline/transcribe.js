import fs from 'node:fs/promises';
import { assertAudioFile } from '../audio/fileCheck.js';
import { compressForSpeech, cutCopy, probeAudio } from '../audio/ffmpeg.js';
import { audioTooLong, noProviderConfigured } from '../lib/errors.js';
import { withBackoff, withTimeout } from '../lib/retry.js';
import { startEstimate } from '../lib/progress.js';
import { ingestWhisperSegments } from '../transcript/segmenter.js';
import { formatClock } from '../transcript/timecodes.js';
import { logger } from '../lib/logger.js';

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

// Seconds of audio shared by neighbouring chunks, so no word is lost at a cut.
export const CHUNK_OVERLAP_SEC = 4;
// Codecs that are already compressed: splitting them by stream copy keeps every chunk small.
const COMPRESSED_CODECS = new Set(['mp3', 'aac', 'opus', 'vorbis', 'mp2']);
// Containers Groq accepts, keyed by the detected content type, with the extension to write chunks in.
const CHUNK_EXT = { mp3: 'mp3', m4a: 'm4a', mp4: 'm4a', ogg: 'ogg', oga: 'ogg', opus: 'ogg', webm: 'webm', flac: 'flac', wav: 'wav' };

/**
 * Decide how to get the file under the provider's per-request size limit while spending as little
 * server CPU as possible (the free instance is ~60x slower than a laptop at re-encoding):
 *   pass    – already small enough: send as-is (the browser usually compressed it already)
 *   split   – compressed codec: cut into chunks by stream copy, no re-encoding
 *   compress – uncompressed or odd input: re-encode (slow path), then split if still too big
 */
export function planTranscription({ size, duration, codec, detectedExt }, { maxBytes, minChunkSec, maxCopyChunks = 10 }) {
  const ext = CHUNK_EXT[detectedExt];
  if (size <= maxBytes && ext) return { mode: 'pass' };
  const bytesPerSec = size / duration;
  const chunkSec = Math.floor((maxBytes * 0.85) / bytesPerSec) - CHUNK_OVERLAP_SEC;
  const chunks = Math.ceil(duration / Math.max(chunkSec, 1));
  if (ext && COMPRESSED_CODECS.has(codec) && chunkSec >= minChunkSec && chunks <= maxCopyChunks) {
    return { mode: 'split', chunkSec, chunks, ext };
  }
  return { mode: 'compress' };
}

export function chunkWindows(duration, chunkSec) {
  const windows = [];
  for (let start = 0; start < duration; start += chunkSec) {
    windows.push({ start, duration: Math.min(chunkSec + CHUNK_OVERLAP_SEC, duration - start) });
  }
  return windows;
}

/**
 * Join per-chunk Whisper segments into one timeline. Each chunk's times are shifted by its offset,
 * and in each overlap the cut is made at the overlap's midpoint, so every moment comes from
 * exactly one chunk.
 */
export function stitchSegments(parts) {
  const out = [];
  parts.forEach((p, i) => {
    const lower = i === 0 ? -Infinity : p.offset + CHUNK_OVERLAP_SEC / 2;
    const upper = i === parts.length - 1 ? Infinity : parts[i + 1].offset + CHUNK_OVERLAP_SEC / 2;
    for (const s of p.segments) {
      const start = (s.start ?? 0) + p.offset;
      if (start < lower || start >= upper) continue;
      out.push({ ...s, start, end: (s.end ?? s.start ?? 0) + p.offset });
    }
  });
  return out;
}

async function transcribeOne(file, { providers, signal, progress, label }) {
  return withBackoff(
    () =>
      withTimeout((s) => providers.whisper.transcribe(file, { signal: s }), 10 * 60_000, {
        provider: providers.whisper.name,
        parentSignal: signal,
      }),
    {
      attempts: 2,
      signal,
      onRetry: (err, { attempt, of, waitMs }) =>
        progress.notice(`${label ? `${label}: ` : ''}${err.message} Retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${attempt} of ${of})…`, {
          level: 'warn',
          provider: providers.whisper.name,
        }),
    },
  );
}

/**
 * Audio → timed segments: magic-byte check → probe → (pass | split | compress) → Whisper → stitch → segment.
 * Temp files are always deleted, including on failure or client disconnect.
 */
export async function transcribeAudio({ file, config, providers, progress, signal }) {
  const temp = [];
  try {
    if (!providers.whisper) throw noProviderConfigured('audio transcription');

    progress.stage('validating', { message: `${file.originalname} (${mb(file.size)} MB)` });
    const detected = await assertAudioFile(file.path, file.originalname);

    progress.stage('probing');
    const { duration, codec } = await probeAudio(file.path, { signal });
    if (duration > config.limits.audioSeconds) {
      throw audioTooLong(
        `This audio is ${formatClock(duration)} long; the limit is ${formatClock(config.limits.audioSeconds)}. ` +
          'The free transcription quota allows about 2 hours of audio per hour for all users.',
      );
    }

    const maxBytes = config.limits.compressedAudioBytes;
    const limits = { maxBytes, minChunkSec: config.limits.copyChunkMinSeconds };
    let source = file.path;
    let size = file.size;
    let plan = planTranscription({ size, duration, codec, detectedExt: detected.ext }, limits);
    logger.info('transcription plan', { mode: plan.mode, sizeMb: mb(size), duration: Math.round(duration), codec, chunks: plan.chunks });

    if (plan.mode === 'compress') {
      // Slow path: only for uncompressed/odd formats the browser could not shrink first.
      const compressed = `${file.path}.speech.ogg`;
      temp.push(compressed);
      progress.stage('compressing', {
        message: `${formatClock(duration)} of ${codec ?? 'audio'}. Converting to a compact format; MP3 or M4A uploads skip this step.`,
        percent: 0,
      });
      let lastEmit = 0;
      await compressForSpeech(file.path, compressed, {
        durationSec: duration,
        bitrate: config.audioBitrate,
        signal,
        onProgress: ({ percent, etaSeconds }) => {
          if (Date.now() - lastEmit < 1000) return; // ~1 event/s
          lastEmit = Date.now();
          progress.update({ percent, etaSeconds });
        },
      });
      source = compressed;
      size = (await fs.stat(compressed)).size;
      progress.update({ percent: 100, message: `Compressed ${mb(file.size)} MB → ${mb(size)} MB` });
      plan = planTranscription({ size, duration, codec: 'opus', detectedExt: 'ogg' }, { ...limits, minChunkSec: 1, maxCopyChunks: 50 });
    }

    // Build the list of files to send.
    let pieces;
    if (plan.mode === 'split') {
      const windows = chunkWindows(duration, plan.chunkSec);
      progress.stage('splitting', { message: `${formatClock(duration)} split into ${windows.length} parts without re-encoding`, percent: 0 });
      pieces = [];
      for (let i = 0; i < windows.length; i++) {
        const out = `${source}.part${i}.${plan.ext}`;
        temp.push(out);
        await cutCopy(source, out, { ...windows[i], signal });
        pieces.push({ path: out, offset: windows[i].start, duration: windows[i].duration });
        progress.update({ percent: ((i + 1) / windows.length) * 100 });
      }
    } else {
      pieces = [{ path: source, offset: 0, duration }];
    }

    // Groq lists ~200x real time for whisper-large-v3-turbo; add upload time and per-request overhead.
    const totalEta = Math.round(pieces.length * 6 + duration / 150 + size / (1024 * 1024));
    progress.stage('transcribing', {
      etaSeconds: totalEta,
      message: pieces.length > 1 ? `Sending ${pieces.length} parts to ${providers.whisper.name}` : `Sending ${formatClock(duration)} of audio to ${providers.whisper.name}`,
    });
    const parts = [];
    let language = null;
    const started = Date.now();
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      const label = pieces.length > 1 ? `Part ${i + 1} of ${pieces.length}` : null;
      if (label) progress.update({ percent: (i / pieces.length) * 100, message: label, etaSeconds: Math.max(0, totalEta - (Date.now() - started) / 1000) });
      const stop = pieces.length === 1 ? startEstimate(progress, totalEta) : () => {};
      let result;
      try {
        result = await transcribeOne(piece.path, { providers, signal, progress, label });
      } finally {
        stop();
      }
      language ??= result.language;
      parts.push({ offset: piece.offset, segments: result.segments });
    }

    progress.stage('segmenting');
    const ingested = ingestWhisperSegments(stitchSegments(parts));
    return {
      segments: ingested.segments,
      hasTimestamps: true,
      source: 'audio',
      words: ingested.words,
      durationSec: duration,
      language,
      provider: providers.whisper.name,
      processing: plan.mode,
    };
  } finally {
    await Promise.all([file.path, ...temp].map((p) => fs.rm(p, { force: true }))).catch((err) =>
      logger.warn('temp file cleanup failed', { message: err.message }),
    );
  }
}
