import { distance } from 'fastest-levenshtein';

/** Lowercase, unify quotes/dashes, drop punctuation, collapse whitespace. */
export function normalizeText(s) {
  return String(s)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―-]/g, ' ')
    .replace(/[^\p{L}\p{N}\s']/gu, '')
    .replace(/'/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const similarity = (a, b) => 1 - distance(a, b) / Math.max(a.length, b.length, 1);

/**
 * Does `quote` appear in the cited segments (plus one neighbour on each side, so quotes that
 * span a segment boundary or are cited off-by-one still match)?
 *
 * Exact match after normalisation, else best sliding-window similarity over word windows of
 * roughly the quote's length. Tolerates ASR typos and small paraphrase-free edits, rejects
 * invented sentences.
 */
export function checkQuote(quote, citedIds, segments, threshold = 0.9) {
  const nq = normalizeText(quote);
  const qWords = nq ? nq.split(' ') : [];
  if (qWords.length < 3) return { ok: false, score: 0, reason: 'quote is too short to verify' };

  const index = new Map(segments.map((s, i) => [s.id, i]));
  const picked = new Set();
  for (const id of citedIds) {
    const i = index.get(id);
    if (i === undefined) continue;
    for (const j of [i - 1, i, i + 1]) if (j >= 0 && j < segments.length) picked.add(j);
  }
  if (!picked.size) return { ok: false, score: 0, reason: 'cites no existing segment' };

  const hay = normalizeText([...picked].sort((a, b) => a - b).map((i) => segments[i].text).join(' '));
  if (hay.includes(nq)) return { ok: true, score: 1 };

  const hWords = hay.split(' ');
  let best = 0;
  let bestWindow = [];
  for (const len of [qWords.length - 1, qWords.length, qWords.length + 1]) {
    if (len < 1) continue;
    for (let i = 0; i + len <= hWords.length; i++) {
      const window = hWords.slice(i, i + len);
      const s = similarity(nq, window.join(' '));
      if (s > best) {
        best = s;
        bestWindow = window;
      }
    }
  }
  if (best < threshold) {
    return { ok: false, score: best, reason: `quote not found in the cited segments (best match ${Math.round(best * 100)}%)` };
  }

  // Character similarity alone lets a changed number or name slip through ("13" vs "18" is one
  // character). Numbers must match exactly, and most words must appear verbatim.
  const windowSet = new Set(bestWindow);
  const badNumbers = qWords.filter((w) => /\d/.test(w) && !windowSet.has(w));
  if (badNumbers.length) {
    return { ok: false, score: best, reason: `quote contains number(s) not in the transcript: ${badNumbers.join(', ')}` };
  }
  const exactShare = qWords.filter((w) => windowSet.has(w)).length / qWords.length;
  if (exactShare < 0.8) {
    return { ok: false, score: best, reason: `too many quote words differ from the transcript (${Math.round(exactShare * 100)}% match)` };
  }
  return { ok: true, score: best };
}
