import { parseClock } from './timecodes.js';

const CUE_TIMING = /^\s*((?:\d{1,2}:)?\d{1,3}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,3}:\d{2}[.,]\d{1,3})/;

export const looksLikeSubtitles = (text) => /-->/.test(text) && CUE_TIMING.test(text.split(/\r?\n/).find((l) => l.includes('-->')) ?? '');

/**
 * Parse SRT or WebVTT into timed units. Strips cue numbers, VTT headers/notes,
 * and inline markup like <i> or <v Speaker>.
 */
export function parseSubtitles(text) {
  const blocks = text.replace(/\r/g, '').split(/\n{2,}/);
  const units = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => CUE_TIMING.test(l));
    if (idx === -1) continue;
    const [, a, b] = CUE_TIMING.exec(lines[idx]);
    const start = parseClock(a);
    const end = parseClock(b);
    const body = lines
      .slice(idx + 1)
      .join(' ')
      .replace(/<v\s+([^>]+)>/g, '$1: ')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (start === null || !body) continue;
    // Auto-captions often repeat the previous cue's text; skip exact repeats.
    if (units.length && units[units.length - 1].text === body) {
      units[units.length - 1].end = end;
      continue;
    }
    units.push({ start, end, text: body });
  }
  return units;
}
