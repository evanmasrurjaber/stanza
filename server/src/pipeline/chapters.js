import { WORDS_PER_MINUTE } from '../transcript/segmenter.js';

export const MIN_CHAPTER_MIN = 3;
export const MAX_CHAPTER_MIN = 25;
const MINUTES_PER_CHAPTER = 10;

const wc = (s) => (s.match(/\S+/g) ?? []).length;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** About one chapter per ~10 minutes, 3–12 total, never more than one per 3 segments. */
export function targetChapterCount(estimatedMinutes, segmentCount) {
  const byLength = clamp(Math.round(estimatedMinutes / MINUTES_PER_CHAPTER), 3, 12);
  return clamp(Math.min(byLength, Math.floor(segmentCount / 3)), 1, 12);
}

/**
 * Turn model chapter drafts ({ startSegmentId, title, explanation }) into final chapters.
 * The model only chooses where chapters start; code guarantees the structure:
 *   - unknown IDs dropped, order sorted, duplicates removed, first chapter starts at segment 1
 *   - no gaps or overlaps (each chapter ends where the next starts)
 *   - with timestamps, a start on an untimed segment snaps back to the nearest timed one
 *   - chapters shorter than ~3 min are merged into a neighbour
 *   - times come only from segment data, never from the model
 *
 * Returns { value, errors }: value null means the drafts are unusable (triggers a repair call).
 */
export function buildChapters(drafts, segments, { hasTimestamps }) {
  const index = new Map(segments.map((s, i) => [s.id, i]));
  const errors = [];

  const unknown = drafts.filter((d) => !index.has(d.startSegmentId)).map((d) => d.startSegmentId);
  if (unknown.length) errors.push(`Unknown startSegmentId(s): ${unknown.slice(0, 5).join(', ')}.`);
  let items = drafts
    .filter((d) => index.has(d.startSegmentId) && d.title.trim())
    .map((d) => ({ startIdx: index.get(d.startSegmentId), title: d.title.trim(), explanation: d.explanation.trim() }));

  if (!items.length || unknown.length > drafts.length / 2) {
    return { value: null, errors: errors.length ? errors : ['No usable chapters were returned.'] };
  }

  const sorted = [...items].sort((a, b) => a.startIdx - b.startIdx);
  if (sorted.some((c, i) => c !== items[i])) errors.push('Chapters were not in ascending order; they were sorted.');
  items = sorted;

  if (hasTimestamps) {
    for (const c of items) {
      let i = c.startIdx;
      while (i > 0 && segments[i].start == null) i--;
      c.startIdx = i;
    }
  }

  items = items.filter((c, i) => i === 0 || c.startIdx !== items[i - 1].startIdx);
  items[0].startIdx = 0;

  // Length of a chapter in minutes: real times when available, otherwise estimated from words.
  const wordsBefore = [0];
  for (const s of segments) wordsBefore.push(wordsBefore.at(-1) + wc(s.text));
  const endTime = segments.at(-1).end ?? segments.at(-1).start;
  const minutes = (startIdx, endIdx) => {
    if (hasTimestamps && segments[startIdx].start != null) {
      const end = endIdx < segments.length ? segments[endIdx].start : endTime;
      if (end != null) return (end - segments[startIdx].start) / 60;
    }
    return (wordsBefore[endIdx] - wordsBefore[startIdx]) / WORDS_PER_MINUTE;
  };
  const totalMinutes = minutes(0, segments.length);
  // Short episodes get proportionally shorter minimum chapters.
  const minLen = Math.min(MIN_CHAPTER_MIN, totalMinutes / 6);

  let merged = true;
  while (merged && items.length > 1) {
    merged = false;
    for (let i = 0; i < items.length; i++) {
      const end = i + 1 < items.length ? items[i + 1].startIdx : segments.length;
      if (minutes(items[i].startIdx, end) >= minLen) continue;
      if (i === 0) {
        // Fold a tiny opening into the next chapter, which now starts at the beginning.
        items[1].startIdx = 0;
        items.splice(0, 1);
      } else {
        items.splice(i, 1);
      }
      errors.push('A very short chapter was merged into its neighbour.');
      merged = true;
      break;
    }
  }

  const chapters = items.map((c, i) => {
    const endIdx = i + 1 < items.length ? items[i + 1].startIdx : segments.length; // exclusive
    const first = segments[c.startIdx];
    const lastSeg = segments[endIdx - 1];
    const start = hasTimestamps ? first.start : null;
    const end = hasTimestamps ? (endIdx < segments.length ? segments[endIdx].start : (lastSeg.end ?? lastSeg.start)) : null;
    return {
      id: `C${i + 1}`,
      startSegmentId: first.id,
      endSegmentId: lastSeg.id,
      title: c.title,
      explanation: c.explanation,
      start,
      end,
    };
  });

  const tooLong = chapters.filter((c) => minutes(index.get(c.startSegmentId), index.get(c.endSegmentId) + 1) > MAX_CHAPTER_MIN);
  if (tooLong.length) errors.push(`Chapter(s) longer than ${MAX_CHAPTER_MIN} min: ${tooLong.map((c) => c.id).join(', ')}.`);

  return { value: chapters, errors };
}

/** Segment IDs covered by a chapter, inclusive. */
export function chapterSegmentIds(chapter, segments) {
  const ids = segments.map((s) => s.id);
  return ids.slice(ids.indexOf(chapter.startSegmentId), ids.indexOf(chapter.endSegmentId) + 1);
}
