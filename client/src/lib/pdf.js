import { clock } from './format.js';
import { slug } from './markdown.js';
import { chapterTime } from './plainText.js';

/*
 * The edition as a real PDF file (not the print dialog), generated in the browser with jsPDF.
 * jsPDF is loaded only when the user asks for a PDF, so it costs nothing otherwise.
 *
 * Contents: summary, themes, key takeaways, chapters (with times), quiz, and an answer key with
 * each answer's supporting quote and time. Citations are left out; the full numbered transcript
 * stays in the Markdown export.
 *
 * Limitation: jsPDF's built-in fonts cover Western European text (WinAnsi). Other scripts would
 * need an embedded TTF font; that comes with multi-language support.
 */

const PAGE = { w: 210, h: 297, margin: 20 };
const WIDTH = PAGE.w - PAGE.margin * 2;
const YELLOW = [245, 196, 0];
const INK = [20, 20, 20];
const MUTED = [94, 94, 94];

// Characters jsPDF's standard fonts can show: Latin-1 plus the WinAnsi extras (smart quotes, dashes, …).
const WINANSI_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const clean = (s) =>
  String(s ?? '')
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .replace(/[^\u0000-ÿ]/g, (ch) => (WINANSI_EXTRA.has(ch) ? ch : '?'))
    .trim();

/** Build the PDF document (exported separately so it can be tested without a browser download). */
async function buildPdf({ title, overview, quiz, segments = [] }) {
  const startOf = new Map(segments.map((s) => [s.id, s.start]));
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  let y = PAGE.margin;

  const ensure = (h) => {
    if (y + h > PAGE.h - PAGE.margin) {
      doc.addPage();
      y = PAGE.margin;
    }
  };
  const font = (family, style, size, color = INK) => {
    doc.setFont(family, style);
    doc.setFontSize(size);
    doc.setTextColor(...color);
  };
  const lineHeight = (size, factor = 1.45) => (size * factor * 25.4) / 72; // pt → mm

  /** Wrapped paragraph with an optional hanging label (e.g. "3." or "A)"). */
  const para = (text, { family = 'times', style = 'normal', size = 11, color = INK, indent = 0, label = null, labelAt = 0, after = 2.5 } = {}) => {
    font(family, style, size, color);
    const lh = lineHeight(size);
    const lines = doc.splitTextToSize(clean(text), WIDTH - indent);
    lines.forEach((line, i) => {
      ensure(lh);
      if (i === 0 && label) {
        font('helvetica', 'bold', size - 1, color);
        doc.text(label, PAGE.margin + labelAt, y + lh * 0.75);
        font(family, style, size, color);
      }
      doc.text(line, PAGE.margin + indent, y + lh * 0.75);
      y += lh;
    });
    y += after;
  };

  const heading = (text, keep = 45) => {
    // Keep a heading with the start of its section instead of stranding it at a page end.
    ensure(keep);
    y += 4;
    doc.setDrawColor(...INK);
    doc.setLineWidth(0.6);
    doc.line(PAGE.margin, y, PAGE.margin + WIDTH, y);
    y += 7;
    font('helvetica', 'bold', 15);
    doc.text(clean(text), PAGE.margin, y);
    y += 6;
  };

  const status = (v) => (!v ? null : v.status === 'unchecked' ? 'Not independently fact-checked.' : `${v.status === 'partial' ? 'Partly fact-checked' : 'Fact-checked'} against the transcript.`);

  // Cover band
  doc.setFillColor(...YELLOW);
  doc.rect(0, 0, PAGE.w, 14, 'F');
  font('helvetica', 'bold', 11);
  doc.text('Stanza', PAGE.margin, 9.2);
  y = 30;
  font('helvetica', 'bold', 20);
  for (const line of doc.splitTextToSize(clean(title), WIDTH)) {
    doc.text(line, PAGE.margin, y);
    y += lineHeight(20, 1.2);
  }
  font('helvetica', 'normal', 9, MUTED);
  doc.text(`Study edition · generated ${new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })}`, PAGE.margin, y + 2);
  y += 8;

  // Summary
  heading('Summary');
  const summary = overview.summarySentences.map((s) => s.text).join(' ');
  para(summary, { size: 11.5 });
  if (overview.themes?.length) para(`Themes: ${overview.themes.join(', ')}`, { family: 'helvetica', size: 9.5, color: MUTED });
  if (status(overview.verification)) para(status(overview.verification), { family: 'helvetica', style: 'italic', size: 9, color: MUTED });

  // Key takeaways
  heading('Key takeaways');
  overview.takeaways.forEach((t, i) => para(t.text, { indent: 8, label: `${i + 1}.` }));

  // Chapters
  heading('Chapters');
  overview.chapters.forEach((c, i) => {
    ensure(14);
    const time = chapterTime(c);
    font('helvetica', 'bold', 11.5);
    const titleLines = doc.splitTextToSize(clean(`${i + 1}. ${c.title}`), WIDTH - (time ? 30 : 0));
    titleLines.forEach((line, j) => {
      doc.text(line, PAGE.margin, y + 4);
      if (j === 0 && time) {
        font('helvetica', 'normal', 9.5, MUTED);
        doc.text(time, PAGE.margin + WIDTH, y + 4, { align: 'right' });
        font('helvetica', 'bold', 11.5);
      }
      y += lineHeight(11.5, 1.3);
    });
    y += 1;
    para(c.explanation, { color: [59, 59, 59], after: 4 });
  });

  // Quiz
  if (quiz?.questions?.length) {
    heading('Quiz', 75); // heading + status line + one full question
    if (status(quiz.verification)) para(status(quiz.verification), { family: 'helvetica', style: 'italic', size: 9, color: MUTED });
    quiz.questions.forEach((q, i) => {
      ensure(30);
      para(q.question, { family: 'helvetica', style: 'bold', size: 11, indent: 8, label: `${i + 1}.`, after: 1.5 });
      q.options.forEach((o, j) => para(o, { indent: 15, label: `${'ABCD'[j]})`, labelAt: 8, after: 0.8 }));
      y += 3;
    });

    heading('Answers', 55);
    quiz.questions.forEach((q, i) => {
      ensure(20);
      para(`${'ABCD'[q.answerIndex]}) ${q.options[q.answerIndex]}`, { family: 'helvetica', style: 'bold', size: 10.5, indent: 8, label: `${i + 1}.`, after: 1 });
      if (q.explanation) para(q.explanation, { indent: 8, size: 10.5, after: 1 });
      const t = startOf.get(q.segmentIds[0]);
      const firstStart = t != null ? ` (at ${clock(t)})` : '';
      para(`“${q.quote}”${firstStart}`, { style: 'italic', size: 10, indent: 8, color: [59, 59, 59], after: 4 });
    });
  }

  // Footer on every page
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    font('helvetica', 'normal', 8, MUTED);
    doc.text(`Stanza · ${clean(title).slice(0, 70)}`, PAGE.margin, PAGE.h - 10);
    doc.text(`${p} / ${pages}`, PAGE.margin + WIDTH, PAGE.h - 10, { align: 'right' });
  }

  return doc;
}

export async function downloadPdf(edition) {
  const doc = await buildPdf(edition);
  doc.save(`${slug(edition.title)}.pdf`);
}
