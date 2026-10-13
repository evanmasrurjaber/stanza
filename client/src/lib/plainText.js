import { clock } from './format.js';

/*
 * Clean, citation-free text for copying. Citations (¶ numbers, segment IDs) belong in the edition
 * and the Markdown export; copied text is meant to be pasted into notes or a document as-is.
 */

export function summaryText(overview) {
  const body = overview.summarySentences?.length ? overview.summarySentences.map((s) => s.text.trim()).join(' ') : overview.summary.trim();
  return overview.themes?.length ? `${body}\n\nThemes: ${overview.themes.join(', ')}` : body;
}

export function takeawaysText(takeaways) {
  return takeaways.map((t, i) => `${i + 1}. ${t.text.trim()}`).join('\n');
}

export const chapterTime = (c) => (c.start != null ? `${clock(c.start)}–${clock(c.end)}` : null);

export function chaptersText(chapters) {
  return chapters
    .map((c, i) => {
      const time = chapterTime(c);
      return `${i + 1}. ${c.title.trim()}${time ? ` (${time})` : ''}\n${c.explanation.trim()}`;
    })
    .join('\n\n');
}

/** Copy to the clipboard; falls back to a hidden textarea where the async API is unavailable. */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.setAttribute('readonly', '');
    ta.style.position = 'absolute';
    ta.style.left = '-9999px';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
