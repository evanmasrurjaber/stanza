import fs from 'node:fs/promises';
import { assertAudioFile } from '../audio/fileCheck.js';
import { compressForSpeech, cutCopy, probeAudio } from '../audio/ffmpeg.js';
import { AppError, CODES, allProvidersFailed, audioTooLong, noProviderConfigured } from '../lib/errors.js';
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
// Containers the providers accept, keyed by the detected content type, with the extension to write chunks in.
const CHUNK_EXT = { mp3: 'mp3', m4a: 'm4a', mp4: 'm4a', ogg: 'ogg', oga: 'ogg', opus: 'ogg', webm: 'webm', flac: 'flac', wav: 'wav' };

/**
 * Decide how to get the file under Whisper's per-request size limit while spending as little
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
 * Join per-chunk segments into one timeline. Each chunk's times are shifted by its offset, and in
 * each overlap the cut is made at the overlap's midpoint, so every moment comes from exactly one chunk.
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

// After these errors, the next transcription provider is worth trying.
const canFallBack = (err) => err instanceof AppError && (err.category === 'provider' || err.code === CODES.PROVIDER_AUTH);

// Rough real-time factors for ETA display only (Groq lists ~200x for Whisper turbo; Gemini Transcribe is slower).
const speedOf = (provider) => (provider.maxChunkSeconds ? 60 : 150);

async function transcribeOne(provider, file, { signal, progress, label }) {
  return withBackoff(
    () =>
      withTimeout((s) => provider.transcribe(file, { signal: s }), 10 * 60_000, {
        provider: provider.name,
        parentSignal: signal,
      }),
    {
      attempts: 2,
      signal,
      onRetry: (err, { attempt, of, waitMs }) =>
        progress.notice(`${label ? `${label}: ` : ''}${err.message} Retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${attempt} of ${of})…`, {
          level: 'warn',
          provider: provider.name,
        }),
    },
  );
}

/**
 * Audio → timed segments: magic-byte check → probe → (pass | split | compress) → transcribe → stitch → segment.
 *
 * Transcription runs on Groq Whisper. If it fails with a provider problem (rate limit, quota,
 * outage, rejected key), the audio from the failed part onward is re-cut for Gemini Transcribe
 * (≤ 30-minute parts, its limit with word timestamps) and transcription continues there; parts
 * already transcribed are kept. Temp files are always deleted, including on failure or disconnect.
 */
export async function transcribeAudio({ file, config, providers, progress, signal }) {
  const temp = [];
  try {
    const chain = [providers.whisper, providers.transcribeFallback].filter(Boolean);
    if (!chain.length) throw noProviderConfigured('audio transcription');

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

    let source = file.path;
    let sourceExt = CHUNK_EXT[detected.ext] ?? 'ogg';
    let size = file.size;
    let mode = 'pass';
    let provider = chain[0];

    // Whisper has a per-request size limit (25 MB); Gemini Transcribe only has a duration cap.
    let initialChunkSec = null;
    if (!provider.maxChunkSeconds) {
      const limits = { maxBytes: config.limits.compressedAudioBytes, minChunkSec: config.limits.copyChunkMinSeconds };
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
        sourceExt = 'ogg';
        size = (await fs.stat(compressed)).size;
        progress.update({ percent: 100, message: `Compressed ${mb(file.size)} MB → ${mb(size)} MB` });
        plan = planTranscription({ size, duration, codec: 'opus', detectedExt: 'ogg' }, { ...limits, minChunkSec: 1, maxCopyChunks: 50 });
        mode = 'compress';
      }
      if (plan.mode === 'split') {
        initialChunkSec = plan.chunkSec;
        if (mode === 'pass') mode = 'split';
      }
    }

    let cutCount = 0;
    /** Files to send to `p` covering [from, duration); cuts by stream copy only when needed. */
    async function piecesFor(p, from, chunkSec) {
      const remaining = duration - from;
      const step = chunkSec ?? (p.maxChunkSeconds ? p.maxChunkSeconds - CHUNK_OVERLAP_SEC : null);
      if (from === 0 && (!step || remaining <= step + CHUNK_OVERLAP_SEC)) return [{ path: source, offset: 0, duration }];
      const windows = chunkWindows(remaining, step ?? remaining).map((w) => ({ start: w.start + from, duration: w.duration }));
      progress.stage('splitting', {
        message: `${formatClock(remaining)} split into ${windows.length} part${windows.length === 1 ? '' : 's'} for ${p.name}, without re-encoding`,
        percent: 0,
      });
      const out = [];
      for (let i = 0; i < windows.length; i++) {
        const target = `${source}.part${cutCount++}.${sourceExt}`;
        temp.push(target);
        await cutCopy(source, target, { ...windows[i], signal });
        out.push({ path: target, offset: windows[i].start, duration: windows[i].duration });
        progress.update({ percent: ((i + 1) / windows.length) * 100 });
      }
      return out;
    }

    let pieces = await piecesFor(provider, 0, initialChunkSec);
    const parts = [];
    const used = [];
    const attempts = [];
    let language = null;

    const announce = () => {
      const left = pieces.reduce((n, p) => n + p.duration, 0);
      const eta = Math.round(pieces.length * 6 + left / speedOf(provider) + size / (1024 * 1024));
      progress.stage('transcribing', {
        etaSeconds: eta,
        message: pieces.length > 1 ? `Sending ${pieces.length} parts to ${provider.name}` : `Sending ${formatClock(left)} of audio to ${provider.name}`,
      });
      return { eta, started: Date.now() };
    };
    let clock = announce();

    for (let i = 0; i < pieces.length; ) {
      const piece = pieces[i];
      const label = pieces.length > 1 ? `Part ${i + 1} of ${pieces.length}` : null;
      if (label) progress.update({ percent: (i / pieces.length) * 100, message: label, etaSeconds: Math.max(0, clock.eta - (Date.now() - clock.started) / 1000) });
      const stop = pieces.length === 1 ? startEstimate(progress, clock.eta) : () => {};
      let result;
      try {
        result = await transcribeOne(provider, piece.path, { signal, progress, label });
      } catch (err) {
        stop();
        if (!canFallBack(err)) throw err;
        attempts.push({ provider: provider.name, code: err.code, message: err.message });
        const next = chain[chain.indexOf(provider) + 1];
        if (!next) {
          if (attempts.length === 1) throw err;
          throw allProvidersFailed(`Every transcription service failed. ${attempts.map((a) => `${a.provider}: ${a.message}`).join(' ')}`, attempts, {
            retryable: !attempts.every((a) => a.code === CODES.PROVIDER_QUOTA_EXHAUSTED),
          });
        }
        logger.warn('transcription provider failed; switching', { from: provider.name, to: next.name, code: err.code, atSec: Math.round(piece.offset) });
        progress.notice(
          `${err.message} Switching to the backup transcription service (${next.name})` +
            (piece.offset > 0 ? ` from ${formatClock(piece.offset)}; the part already transcribed is kept…` : '…'),
          { level: 'warn', provider: provider.name },
        );
        provider = next;
        pieces = await piecesFor(provider, piece.offset, null);
        i = 0;
        clock = announce();
        continue;
      }
      stop();
      language ??= result.language;
      parts.push({ offset: piece.offset, segments: result.segments });
      if (!used.includes(provider.name)) used.push(provider.name);
      i++;
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
      provider: used.join(', then '),
      processing: mode,
    };
  } finally {
    await Promise.all([file.path, ...temp].map((p) => fs.rm(p, { force: true }))).catch((err) =>
      logger.warn('temp file cleanup failed', { message: err.message }),
    );
  }
}
