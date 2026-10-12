import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { audioProcessingFailed, audioUnreadable, clientAborted } from '../lib/errors.js';

/**
 * Run a binary, collecting stdout/stderr. Kills the process on abort or timeout.
 * `onStdoutLine` receives each stdout line as it arrives (used for ffmpeg -progress).
 */
function run(bin, args, { signal, timeoutMs, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(clientAborted());
    const child = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let pending = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString();
      stdout += chunk;
      if (!onStdoutLine) return;
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      lines.forEach(onStdoutLine);
    });
    child.stderr.on('data', (buf) => {
      stderr = (stderr + buf.toString()).slice(-4000); // keep the tail for diagnostics
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(audioProcessingFailed('The audio tools could not be started on the server.', err));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(clientAborted());
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** Duration in seconds via ffprobe. Unreadable files are an input problem, not a server one. */
export async function probeDuration(file, { signal } = {}) {
  const { code, stdout, stderr, timedOut } = await run(
    ffprobeStatic.path,
    ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file],
    { signal, timeoutMs: 30_000 },
  );
  if (timedOut) throw audioProcessingFailed('Reading the audio file took too long.');
  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    info = null;
  }
  const hasAudio = info?.streams?.some((s) => s.codec_type === 'audio');
  const duration = Number(info?.format?.duration);
  if (code !== 0 || !hasAudio || !Number.isFinite(duration) || duration <= 0) {
    throw audioUnreadable('This file could not be read as audio. It may be corrupted or not really an audio file.', new Error(stderr));
  }
  return duration;
}

/**
 * Re-encode to 16 kHz mono Opus (Whisper downsamples to 16 kHz mono anyway, so nothing useful is lost).
 * Reports real progress from ffmpeg's `-progress` output.
 */
export async function compressForSpeech(input, output, { durationSec, bitrate = '24k', signal, onProgress } = {}) {
  const started = Date.now();
  // Generous: Render's free instance has a small CPU share.
  const timeoutMs = Math.max(3 * 60_000, durationSec * 1000 * 0.5);
  const { code, stderr, timedOut } = await run(
    ffmpegPath,
    ['-hide_banner', '-nostats', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'libopus', '-b:a', bitrate, '-application', 'voip', '-progress', 'pipe:1', output],
    {
      signal,
      timeoutMs,
      onStdoutLine: (line) => {
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
        if (!m || !onProgress || !durationSec) return;
        const done = Number(m[1]) / 1e6; // both fields are microseconds in practice
        const fraction = Math.min(1, done / durationSec);
        const elapsed = (Date.now() - started) / 1000;
        const eta = fraction > 0.02 ? (elapsed / fraction) * (1 - fraction) : null;
        onProgress({ percent: fraction * 100, etaSeconds: eta });
      },
    },
  );
  if (timedOut) throw audioProcessingFailed(`Compressing the audio took longer than ${Math.round(timeoutMs / 60_000)} minutes and was stopped.`);
  if (code !== 0) throw audioUnreadable('The audio could not be decoded. The file may be corrupted.', new Error(stderr));
}
