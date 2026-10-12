import fs from 'node:fs/promises';
import { assertAudioFile } from '../audio/fileCheck.js';
import { compressForSpeech, probeDuration } from '../audio/ffmpeg.js';
import { audioTooLong, fileTooLarge, noProviderConfigured } from '../lib/errors.js';
import { withBackoff, withTimeout } from '../lib/retry.js';
import { startEstimate } from '../lib/progress.js';
import { ingestWhisperSegments } from '../transcript/segmenter.js';
import { formatClock } from '../transcript/timecodes.js';
import { logger } from '../lib/logger.js';

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1);

/**
 * Audio → timed segments: magic-byte check → duration check → compress → Whisper → segment.
 * Temp files are always deleted, including on failure or client disconnect.
 */
export async function transcribeAudio({ file, config, providers, progress, signal }) {
  const compressed = `${file.path}.speech.ogg`;
  try {
    if (!providers.whisper) throw noProviderConfigured('audio transcription');

    progress.stage('validating', { message: `${file.originalname} (${mb(file.size)} MB)` });
    await assertAudioFile(file.path, file.originalname);

    progress.stage('probing');
    const durationSec = await probeDuration(file.path, { signal });
    if (durationSec > config.limits.audioSeconds) {
      throw audioTooLong(
        `This audio is ${formatClock(durationSec)} long; the limit is ${formatClock(config.limits.audioSeconds)}. ` +
          'The free transcription quota allows about 2 hours of audio per hour for all users.',
      );
    }

    progress.stage('compressing', { message: `Audio length ${formatClock(durationSec)}`, percent: 0 });
    let lastEmit = 0;
    await compressForSpeech(file.path, compressed, {
      durationSec,
      bitrate: config.audioBitrate,
      signal,
      onProgress: ({ percent, etaSeconds }) => {
        if (Date.now() - lastEmit < 1000) return; // throttle to ~1 event/s
        lastEmit = Date.now();
        progress.update({ percent, etaSeconds });
      },
    });
    const { size } = await fs.stat(compressed);
    progress.update({ percent: 100, message: `Compressed ${mb(file.size)} MB → ${mb(size)} MB` });
    if (size > config.limits.compressedAudioBytes) {
      throw fileTooLarge(
        `Even after compression the audio is ${mb(size)} MB, over the transcription service's ${mb(config.limits.compressedAudioBytes)} MB limit. Try a shorter recording.`,
      );
    }

    // Groq lists ~200x real-time for whisper-large-v3-turbo; add upload time and overhead.
    const eta = Math.round(8 + durationSec / 150 + size / (1024 * 1024));
    progress.stage('transcribing', { etaSeconds: eta, message: `Sending ${formatClock(durationSec)} of audio to ${providers.whisper.name}` });
    const stop = startEstimate(progress, eta);
    let result;
    try {
      result = await withBackoff(
        () =>
          withTimeout((s) => providers.whisper.transcribe(compressed, { signal: s }), 10 * 60_000, {
            provider: providers.whisper.name,
            parentSignal: signal,
          }),
        {
          attempts: 2,
          signal,
          onRetry: (err, { attempt, of, waitMs }) =>
            progress.notice(`${err.message} Retrying in ${Math.ceil(waitMs / 1000)} s (attempt ${attempt} of ${of})…`, {
              level: 'warn',
              provider: providers.whisper.name,
            }),
        },
      );
    } finally {
      stop();
    }

    progress.stage('segmenting');
    const ingested = ingestWhisperSegments(result.segments);
    return {
      segments: ingested.segments,
      hasTimestamps: true,
      source: 'audio',
      words: ingested.words,
      durationSec: result.duration ?? durationSec,
      language: result.language,
      provider: providers.whisper.name,
    };
  } finally {
    await Promise.all([fs.rm(file.path, { force: true }), fs.rm(compressed, { force: true })]).catch((err) =>
      logger.warn('temp file cleanup failed', { message: err.message }),
    );
  }
}
