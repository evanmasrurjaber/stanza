import { describe, it, expect } from 'vitest';
import { batchByEvidence, factCheckClaims, factCheckQuestions, mergeVerification, verificationSummary } from '../src/pipeline/factcheck.js';
import { factCheckOverviewParts } from '../src/pipeline/overview.js';
import { generateQuiz } from '../src/pipeline/quiz.js';
import { createProgress } from '../src/lib/progress.js';
import { providerQuotaExhausted } from '../src/lib/errors.js';
import { fakeJudge, fakeLlm, makeSegments, quizDraft, testConfig } from './helpers.js';

const segments = makeSegments(60);
const config = testConfig();
const claim = (id, text, ids = ['S0010']) => ({ id, section: id.startsWith('S') ? 'summary' : 'takeaways', text, segmentIds: ids });

function setup({ judge = (a) => fakeJudge(a), writer = () => ({ items: [] }) } = {}) {
  const router = fakeLlm('Groq', judge);
  const primary = fakeLlm('Gemini', writer);
  const events = [];
  return { router, primary, deps: { config, providers: { router, primary, fallback: null } }, progress: createProgress((e) => events.push(e)), events };
}

describe('batchByEvidence', () => {
  it('sends each cited paragraph once, with neighbours, in transcript order', () => {
    const [b] = batchByEvidence([claim('T1', 'a', ['S0010']), claim('T2', 'b', ['S0011'])], segments);
    expect(b.items).toHaveLength(2);
    expect(b.evidence.map((s) => s.id)).toEqual(['S0009', 'S0010', 'S0011', 'S0012']);
  });

  it('starts a new batch when the evidence would exceed the token budget', () => {
    const items = Array.from({ length: 12 }, (_, i) => claim(`T${i + 1}`, 'x', [segments[i * 5].id]));
    const batches = batchByEvidence(items, segments, 400);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((b) => b.items)).toHaveLength(12);
  });
});

describe('factCheckClaims', () => {
  it('keeps supported claims and marks them', async () => {
    const { deps, progress, router } = setup();
    const out = await factCheckClaims({ items: [claim('T1', 'Sleep matters.'), claim('S1', 'Hosts talk.')], segments, deps, progress });
    expect(out.items.map((i) => i.check)).toEqual(['supported', 'supported']);
    expect(out).toMatchObject({ status: 'checked', removed: [], repaired: 0, checker: 'Groq Groq-test' });
    expect(router.calls).toHaveLength(1); // one batched call for both
    expect(router.calls[0].user).not.toMatch(/S0030/); // only cited evidence, not the transcript
  });

  it('repairs a flagged claim once, re-checks it, and keeps the corrected text', async () => {
    const { deps, progress, primary } = setup({
      judge: (a) => fakeJudge(a, { reject: ['always'] }),
      writer: () => ({ items: [{ id: 'T1', text: 'Sleep usually matters.', segmentIds: ['S0010'] }] }),
    });
    const out = await factCheckClaims({ items: [claim('T1', 'Sleep always matters.')], segments, deps, progress });
    expect(out.items).toEqual([{ id: 'T1', section: 'takeaways', text: 'Sleep usually matters.', segmentIds: ['S0010'], check: 'supported' }]);
    expect(out.repaired).toBe(1);
    expect(primary.calls[0].user).toMatch(/Problem \(overstated\): goes beyond the evidence/);
  });

  it('removes a claim the repair cannot fix, with a readable reason', async () => {
    const { deps, progress } = setup({
      judge: (a) => fakeJudge(a, { reject: ['always'], verdict: 'contradicted' }),
      writer: () => ({ items: [{ id: 'T1', text: 'Sleep always matters, really.', segmentIds: ['S0010'] }] }),
    });
    const out = await factCheckClaims({ items: [claim('T1', 'Sleep always matters.'), claim('T2', 'Coffee helps.')], segments, deps, progress });
    expect(out.items.map((i) => i.id)).toEqual(['T2']);
    expect(out.removed).toEqual([{ section: 'takeaways', text: 'Sleep always matters.', reason: 'contradicts the transcript: goes beyond the evidence' }]);
  });

  it('removes a claim the writer deletes (empty text)', async () => {
    const { deps, progress } = setup({
      judge: (a) => fakeJudge(a, { reject: ['moon'], verdict: 'unsupported' }),
      writer: () => ({ items: [{ id: 'T1', text: '', segmentIds: [] }] }),
    });
    const out = await factCheckClaims({ items: [claim('T1', 'The moon is cheese.')], segments, deps, progress });
    expect(out.items).toEqual([]);
    expect(out.removed[0].reason).toMatch(/isn't supported by the part of the transcript it cites/);
  });

  it('marks everything unchecked (and keeps it) when the judge is unavailable', async () => {
    const { deps, progress, events } = setup({
      judge: () => {
        throw providerQuotaExhausted('Groq');
      },
    });
    deps.providers.primary = null; // no backup judge either
    const out = await factCheckClaims({ items: [claim('T1', 'Sleep matters.')], segments, deps, progress });
    expect(out).toMatchObject({ status: 'unchecked', removed: [], items: [{ id: 'T1', check: 'unchecked' }] });
    expect(events.some((e) => e.type === 'notice' && /fact-checker is unavailable/.test(e.message))).toBe(true);
  });

  it('falls back to the writer model as judge when the router model fails', async () => {
    const { deps, progress } = setup({
      judge: () => {
        throw providerQuotaExhausted('Groq');
      },
    });
    deps.providers.primary = fakeLlm('Gemini', (a) => fakeJudge(a));
    const out = await factCheckClaims({ items: [claim('T1', 'Sleep matters.')], segments, deps, progress });
    expect(out).toMatchObject({ status: 'checked', checker: 'Gemini Gemini-test' });
  });
});

describe('factCheckOverviewParts', () => {
  it('never empties a section: if every takeaway fails, originals are kept but unchecked', async () => {
    const { deps, progress } = setup({
      judge: (a) => fakeJudge(a, { reject: ['takeaway'], verdict: 'unsupported' }),
      writer: () => ({ items: [{ id: 'T1', text: '', segmentIds: [] }] }),
    });
    const out = await factCheckOverviewParts({
      summarySentences: [{ text: 'A summary.', segmentIds: ['S0001'] }],
      takeaways: [{ text: 'A takeaway.', segmentIds: ['S0002'] }],
      segments,
      deps,
      progress,
    });
    expect(out.summarySentences).toEqual([{ text: 'A summary.', segmentIds: ['S0001'], check: 'supported' }]);
    expect(out.takeaways).toEqual([{ text: 'A takeaway.', segmentIds: ['S0002'], check: 'unchecked' }]);
    expect(out.verification.removed).toHaveLength(1);
  });
});

describe('factCheckQuestions (blind)', () => {
  const q = (id, options, answerIndex = 0) => ({ id, question: `Question ${id}?`, options, answerIndex, segmentIds: ['S0010'], quote: 'x', explanation: '', difficulty: 'easy' });

  it('confirms when the judge independently picks the marked answer, and never shows it the key', async () => {
    const { deps, progress, router } = setup();
    const out = await factCheckQuestions({ questions: [q('Q1', ['No', 'Right answer', 'Nope', 'Never'], 1)], segments, deps, progress });
    expect(out.kept[0].check).toBe('confirmed');
    expect(router.calls[0].user).not.toMatch(/answerIndex|correct answer|marked/i);
  });

  it('drops wrong keys, unanswerable and ambiguous questions with reasons', async () => {
    const { deps, progress } = setup({
      judge: () => ({
        results: [
          { id: 'Q1', choice: 'B', reason: 'evidence says two years' },
          { id: 'Q2', choice: 'none', reason: 'not discussed' },
          { id: 'Q3', choice: 'multiple', reason: 'A and C both fit' },
        ],
      }),
    });
    const opts = ['a', 'b', 'c', 'd'];
    const out = await factCheckQuestions({ questions: [q('Q1', opts), q('Q2', opts), q('Q3', opts)], segments, deps, progress });
    expect(out.kept).toEqual([]);
    expect(out.dropped.map((d) => d.reason)).toEqual([
      'an independent check picked a different answer (B) from the evidence: evidence says two years',
      "the cited part of the transcript doesn't answer it: not discussed",
      'more than one option fits the cited part of the transcript: A and C both fit',
    ]);
  });
});

describe('generateQuiz with independent check', () => {
  it('refills once when the check leaves too few questions', async () => {
    let writes = 0;
    const primary = fakeLlm('Gemini', (a) => {
      if (a.schemaName !== 'quiz') return fakeJudge(a);
      writes++;
      const d = quizDraft(segments, 4);
      // First draft: only one question has a correct option text; the judge will reject the rest.
      if (writes === 1) d.questions.slice(1).forEach((qq) => (qq.options = ['Wrong 1', 'Wrong 2', 'Wrong 3', 'Wrong 4']));
      return d;
    });
    const router = fakeLlm('Groq', (a) => fakeJudge(a));
    const { quiz } = await generateQuiz({ segments, chapters: [{ id: 'C1', startSegmentId: 'S0001', endSegmentId: 'S0060', title: 't' }], questionCount: 4, config, providers: { primary, router, fallback: null }, progress: createProgress() });
    expect(writes).toBe(2);
    expect(quiz.questions.map((x) => x.id)).toEqual(['Q1', 'Q2', 'Q3', 'Q4']);
    expect(quiz.questions.every((x) => x.check === 'confirmed')).toBe(true);
    expect(quiz.dropped.filter((d) => /answer it/.test(d.reason))).toHaveLength(3);
    expect(quiz.verification.status).toBe('checked');
  });
});

describe('verification status helpers', () => {
  it('summarises and merges statuses', () => {
    expect(verificationSummary({ status: 'unchecked', checker: null }).note).toMatch(/unavailable/);
    expect(mergeVerification(verificationSummary({ status: 'checked', checker: 'g' }), verificationSummary({ status: 'unchecked', checker: null })).status).toBe('partial');
    expect(mergeVerification(undefined, verificationSummary({ status: 'checked', checker: 'g' })).status).toBe('checked');
  });
});
