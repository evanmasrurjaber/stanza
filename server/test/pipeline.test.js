import { describe, it, expect } from 'vitest';
import { buildChapters, targetChapterCount } from '../src/pipeline/chapters.js';
import { checkQuote, normalizeText } from '../src/pipeline/quoteCheck.js';
import { validateQuiz } from '../src/pipeline/quiz.js';
import { validateOverview } from '../src/pipeline/overview.js';
import { validateRoute } from '../src/pipeline/revise.js';
import { makeSegments, overviewDraft, quizDraft } from './helpers.js';

const draft = (startSegmentId, title = `T ${startSegmentId}`) => ({ startSegmentId, title, explanation: 'x' });

describe('targetChapterCount', () => {
  it('scales with length and stays within bounds', () => {
    expect(targetChapterCount(60, 200)).toBe(6);
    expect(targetChapterCount(5, 200)).toBe(3);
    expect(targetChapterCount(300, 1000)).toBe(12);
    expect(targetChapterCount(60, 6)).toBe(2); // never more than one per 3 segments
  });
});

describe('buildChapters', () => {
  const segs = makeSegments(60); // 30 minutes, timed

  it('builds contiguous chapters with times taken from segments', () => {
    const { value } = buildChapters([draft('S0001'), draft('S0013'), draft('S0031')], segs, { hasTimestamps: true });
    expect(value.map((c) => [c.id, c.startSegmentId, c.endSegmentId, c.start, c.end])).toEqual([
      ['C1', 'S0001', 'S0012', 0, 360],
      ['C2', 'S0013', 'S0030', 360, 900],
      ['C3', 'S0031', 'S0060', 900, 1800],
    ]);
  });

  it('sorts, dedupes, drops unknown IDs and forces the first chapter to start at S0001', () => {
    const { value, errors } = buildChapters([draft('S0031'), draft('S0013'), draft('S0013'), draft('S0040'), draft('S7777')], segs, { hasTimestamps: true });
    expect(value.map((c) => c.startSegmentId)).toEqual(['S0001', 'S0031', 'S0040']);
    expect(errors.join(' ')).toMatch(/Unknown startSegmentId.*S7777/);
    expect(errors.join(' ')).toMatch(/sorted/);
  });

  it('merges chapters shorter than 3 minutes into the previous chapter', () => {
    const { value } = buildChapters([draft('S0001'), draft('S0021'), draft('S0023'), draft('S0041')], segs, { hasTimestamps: true });
    expect(value.map((c) => c.startSegmentId)).toEqual(['S0001', 'S0023', 'S0041']);
    expect(value[0].endSegmentId).toBe('S0022');
  });

  it('has no times without timestamps', () => {
    const { value } = buildChapters([draft('S0001'), draft('S0031')], makeSegments(60, { timed: false }), { hasTimestamps: false });
    expect(value.every((c) => c.start === null && c.end === null)).toBe(true);
  });

  it('snaps a start on an untimed segment back to the nearest timed one', () => {
    const s = makeSegments(60);
    s[30].start = null;
    s[29].end = null;
    const { value } = buildChapters([draft('S0001'), draft('S0031')], s, { hasTimestamps: true });
    expect(value[1].startSegmentId).toBe('S0030');
    expect(value[1].start).toBe(870);
  });

  it('rejects mostly-invented IDs (triggers repair)', () => {
    const { value } = buildChapters([draft('S9001'), draft('S9002'), draft('S0001')], segs, { hasTimestamps: true });
    expect(value).toBeNull();
  });

  it('flags chapters over 25 minutes', () => {
    const long = makeSegments(120); // 60 min
    const { errors } = buildChapters([draft('S0001'), draft('S0011')], long, { hasTimestamps: true });
    expect(errors.join(' ')).toMatch(/longer than 25 min: C2/);
  });
});

describe('checkQuote', () => {
  const segs = makeSegments(10);
  const exact = segs[3].text.split('. ')[1];

  it('accepts exact quotes regardless of punctuation and case', () => {
    expect(checkQuote(exact.toUpperCase().replace(/ /g, ', '), ['S0004'], segs)).toMatchObject({ ok: true, score: 1 });
  });

  it('accepts small ASR-style differences', () => {
    const typo = exact.replace('researchers', 'researcher').replace('volunteers', 'volunters');
    expect(checkQuote(typo, ['S0004'], segs).ok).toBe(true);
  });

  it('accepts quotes spanning a segment boundary or cited off by one', () => {
    const spanning = `${segs[3].text.split(' ').slice(-6).join(' ')} ${segs[4].text.split(' ').slice(0, 6).join(' ')}`;
    expect(checkQuote(spanning, ['S0004'], segs).ok).toBe(true);
    expect(checkQuote(exact, ['S0005'], segs).ok).toBe(true);
  });

  it('rejects invented quotes, far-away citations and too-short quotes', () => {
    expect(checkQuote('The guest said coffee cures every known disease instantly.', ['S0004'], segs).ok).toBe(false);
    expect(checkQuote(exact, ['S0010'], segs).ok).toBe(false);
    expect(checkQuote('yes indeed', ['S0004'], segs)).toMatchObject({ ok: false, reason: /too short/ });
    expect(checkQuote(exact, ['S9999'], segs)).toMatchObject({ ok: false, reason: /no existing segment/ });
  });

  it('rejects a near-identical quote whose number was changed (hallucinated detail)', () => {
    const wrongNumber = exact.replace(/\d+ volunteers/, '99 volunteers');
    expect(checkQuote(wrongNumber, ['S0004'], segs)).toMatchObject({ ok: false, reason: /number.*99/ });
  });

  it('normalises curly quotes and dashes', () => {
    expect(normalizeText('It’s “well-known” — really')).toBe('its well known really');
  });
});

describe('validateQuiz', () => {
  const segs = makeSegments(60);
  const opts = { threshold: 0.9, minQuestions: 3, maxQuestions: 6 };

  it('keeps verified questions, numbers them and shuffles the answer position', () => {
    const { value } = validateQuiz(quizDraft(segs, 4), segs, opts);
    expect(value.questions.map((q) => q.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    for (const q of value.questions) expect(q.options[q.answerIndex]).toBe('Right answer');
    expect(new Set(value.questions.map((q) => q.answerIndex)).size).toBeGreaterThan(1);
  });

  it('drops questions with fabricated quotes, duplicate options or unknown facts, with reasons', () => {
    const d = quizDraft(segs, 5);
    d.facts[0].quote = 'The host claimed that the moon is made of cheese and nobody disagreed.';
    d.questions[1].options = ['A', 'a', 'B', 'C'];
    d.questions[2].factId = 'F99';
    const { value } = validateQuiz(d, segs, { ...opts, minQuestions: 2 });
    expect(value.questions).toHaveLength(2);
    expect(value.dropped.map((x) => x.reason)).toEqual([
      expect.stringMatching(/quote could not be verified/),
      expect.stringMatching(/4 distinct options/),
      expect.stringMatching(/unknown fact/),
    ]);
  });

  it('returns null (repair) when too few questions survive', () => {
    const d = quizDraft(segs, 3);
    d.facts.forEach((f) => (f.quote = 'completely invented words that are not anywhere in the text'));
    const { value, errors } = validateQuiz(d, segs, opts);
    expect(value).toBeNull();
    expect(errors.at(-1)).toMatch(/Only 0 question/);
  });
});

describe('validateOverview', () => {
  it('drops unknown takeaway citations and builds chapters', () => {
    const segs = makeSegments(60);
    const { value, errors } = validateOverview(overviewDraft(segs), segs, { hasTimestamps: true });
    expect(value.takeaways[1].segmentIds).toEqual(['S0007']);
    expect(value.chapters).toHaveLength(10);
    expect(errors.join(' ')).toMatch(/unknown segment IDs/);
  });
});

describe('validateRoute', () => {
  const result = {
    overview: { summary: 's', themes: [], takeaways: [], chapters: [{ id: 'C1' }, { id: 'C2' }] },
    quiz: { questions: [{ id: 'Q1' }, { id: 'Q2' }, { id: 'Q3' }], dropped: [] },
    hasTimestamps: true,
  };
  const route = (o) => ({ action: 'revise', targets: [], instruction: 'do it', questionCount: null, clarifyQuestion: null, rejectReason: null, ...o });

  it('passes valid targets through and normalises ids', () => {
    expect(validateRoute(route({ targets: [{ section: 'quiz', ids: ['q3'] }] }), result, 'r')).toMatchObject({
      action: 'revise',
      targets: [{ section: 'quiz', ids: ['Q3'] }],
    });
  });

  it('asks for clarification when an id does not exist', () => {
    const out = validateRoute(route({ targets: [{ section: 'quiz', ids: ['Q9'] }] }), result, 'r');
    expect(out).toMatchObject({ action: 'clarify', clarifyQuestion: expect.stringMatching(/Q9.*Q1–Q3/) });
  });

  it('asks for clarification on no targets or too many sections', () => {
    expect(validateRoute(route(), result, 'r').action).toBe('clarify');
    const four = ['summary', 'takeaways', 'chapters', 'quiz'].map((section) => ({ section, ids: [] }));
    expect(validateRoute(route({ targets: four }), result, 'r').action).toBe('clarify');
  });

  it('rejects quiz edits when there is no quiz', () => {
    const out = validateRoute(route({ targets: [{ section: 'quiz', ids: [] }] }), { ...result, quiz: null }, 'r');
    expect(out.action).toBe('reject');
  });

  it('passes through reject with a default reason', () => {
    expect(validateRoute(route({ action: 'reject', rejectReason: null }), result, 'r')).toMatchObject({ action: 'reject', rejectReason: expect.any(String) });
  });
});
