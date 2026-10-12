export function clock(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return null;
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/** "S0012" → 12 */
export const paraNumber = (segmentId) => Number(String(segmentId).replace(/^S0*/, '')) || 0;

export function megabytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export function eta(seconds) {
  if (seconds == null) return null;
  if (seconds < 5) return 'a few seconds left';
  if (seconds < 60) return `about ${Math.round(seconds / 5) * 5} s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}

export const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

export function extensionOf(name) {
  const m = /\.([^.]+)$/.exec(name ?? '');
  return m ? m[1].toLowerCase() : '';
}
