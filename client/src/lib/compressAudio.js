/**
 * Shrink audio in the browser before upload: decode, downmix to mono and re-encode as Opus in WebM
 * using the browser's native WebCodecs encoders.
 *
 * Why here and not on the server: the free server gets a small slice of one CPU, so re-encoding
 * 47 minutes of audio there took ~15 minutes. A laptop or phone does the same work in seconds, and
 * the upload drops from ~1 MB per minute (128 kbps MP3) to ~0.2 MB per minute.
 *
 * Returns a smaller File, or null when this browser can't do it (no WebCodecs, codec not decodable),
 * in which case the caller uploads the original and the server takes its no-re-encode path.
 */
const BITRATE = 24_000;
// Below this size the upload is quick anyway and the server passes the file straight through.
export const BROWSER_COMPRESS_MIN_BYTES = 6 * 1024 * 1024;

export async function compressAudioInBrowser(file, { onProgress, signal } = {}) {
  if (typeof window === 'undefined' || typeof window.AudioEncoder === 'undefined') return null;

  // Loaded only when someone actually uploads audio.
  const mb = await import('mediabunny');
  let sampleRate = 16_000;
  if (!(await mb.canEncodeAudio('opus', { numberOfChannels: 1, sampleRate, bitrate: BITRATE }))) {
    sampleRate = 48_000; // some encoders only accept Opus's native rate; size depends on bitrate, not rate
    if (!(await mb.canEncodeAudio('opus', { numberOfChannels: 1, sampleRate, bitrate: BITRATE }))) return null;
  }

  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  const output = new mb.Output({ format: new mb.WebMOutputFormat(), target: new mb.BufferTarget() });
  const conversion = await mb.Conversion.init({
    input,
    output,
    tracks: 'primary',
    video: { discard: true },
    audio: { codec: 'opus', numberOfChannels: 1, sampleRate, bitrate: BITRATE, forceTranscode: true },
    showWarnings: false,
  });
  if (!conversion.isValid) return null; // e.g. this browser can't decode the source codec

  conversion.onProgress = (p) => onProgress?.(p);
  const onAbort = () => conversion.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await conversion.execute();
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const buffer = output.target.buffer;
  if (!buffer) return null;
  const name = `${file.name.replace(/\.[^.]+$/, '')}.webm`;
  return new File([buffer], name, { type: 'audio/webm' });
}
