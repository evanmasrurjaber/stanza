/**
 * Parse "h:mm:ss", "mm:ss" (optionally with .ms or ,ms) into seconds. Returns null if malformed.
 */
export function parseClock(str) {
  const m = /^(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(str.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  const minutes = Number(mm);
  const seconds = Number(ss);
  if (seconds >= 60 || (h !== undefined && minutes >= 60)) return null;
  return (Number(h ?? 0) * 3600) + minutes * 60 + seconds + (frac ? Number(`0.${frac}`) : 0);
}

export function formatClock(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return null;
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

// A timecode at the very start of a line: [12:34], (1:02:03), 12:34, 00:12:34.5 — optionally followed
// by a separator such as "-", "|" or ":" before the speaker/text.
const LINE_TIMECODE = /^\s*[[(]?((?:\d{1,2}:)?\d{1,3}:\d{2}(?:[.,]\d{1,3})?)[\])]?\s*(?:[-–—|:]\s*)?(.*)$/;

/**
 * Split text whose lines start with timecodes into timed units.
 * Returns null when the text does not look timecoded (fewer than 3 stamps or not mostly increasing),
 * so the caller can fall back to plain-text handling instead of trusting garbage times.
 */
export function parseTimecodedText(text) {
  const lines = text.split(/\r?\n/);
  const units = [];
  let preamble = [];

  for (const line of lines) {
    const m = LINE_TIMECODE.exec(line);
    const t = m ? parseClock(m[1]) : null;
    if (t !== null) {
      units.push({ start: t, end: null, text: m[2].trim() });
    } else if (line.trim()) {
      if (units.length) units[units.length - 1].text += ` ${line.trim()}`;
      else preamble.push(line.trim());
    }
  }

  if (units.length < 3) return null;
  let increasing = 0;
  for (let i = 1; i < units.length; i++) if (units[i].start >= units[i - 1].start) increasing++;
  if (increasing / (units.length - 1) < 0.9) return null;

  // Text before the first stamp belongs to time 0.
  if (preamble.length) units.unshift({ start: 0, end: null, text: preamble.join(' ') });

  // Each unit ends where the next begins; drop empties and non-monotonic stamps.
  const clean = [];
  for (const u of units) {
    if (!u.text) continue;
    if (clean.length && u.start < clean[clean.length - 1].start) {
      clean[clean.length - 1].text += ` ${u.text}`;
      continue;
    }
    clean.push(u);
  }
  for (let i = 0; i < clean.length - 1; i++) clean[i].end = clean[i + 1].start;
  return clean;
}
