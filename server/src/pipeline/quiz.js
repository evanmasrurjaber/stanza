import { generateStructured } from '../llm/structured.js';
import { LLM_Quiz } from '../schemas/index.js';
import { QUIZ_SYSTEM, quizPrompt } from '../prompts/quiz.js';
import { fitTranscriptPrompt } from '../prompts/common.js';
import { checkQuote } from './quoteCheck.js';
import { estimateLlmSeconds, startEstimate } from '../lib/progress.js';
import { factCheckQuestions, verificationSummary } from './factcheck.js';

/** Deterministic shuffle so the correct answer isn't always where the model put it (models favour A/B). */
function shuffleOptions(options, answerIndex, seedText) {
  // FNV-1a hash of the question → mulberry32 PRNG (an LCG's low bits cycle too quickly for `% n`).
  let seed = 0x811c9dc5;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  const rand = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const order = options.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { options: order.map((i) => options[i]), answerIndex: order.indexOf(answerIndex) };
}

/**
 * Check each question against its fact: 4 distinct options, valid answer index, real segment IDs,
 * and a quote that actually appears in the cited transcript segments. Failing questions are
 * dropped with a reason. Returns null (→ repair call) only if too few questions survive.
 */
export function validateQuiz(data, segments, { threshold, minQuestions, maxQuestions, idOffset = 0 }) {
  const facts = new Map(data.facts.map((f) => [f.id, f]));
  const known = new Set(segments.map((s) => s.id));
  const questions = [];
  const dropped = [];
  const drop = (q, reason) => dropped.push({ question: q.question, reason });

  for (const q of data.questions) {
    if (questions.length >= maxQuestions) break;
    const fact = facts.get(q.factId);
    if (!fact) {
      drop(q, `refers to unknown fact "${q.factId}"`);
      continue;
    }
    const options = q.options.map((o) => o.trim());
    if (options.length !== 4 || new Set(options.map((o) => o.toLowerCase())).size !== 4 || options.some((o) => !o)) {
      drop(q, 'does not have 4 distinct options');
      continue;
    }
    if (!Number.isInteger(q.answerIndex) || q.answerIndex < 0 || q.answerIndex > 3) {
      drop(q, 'has an invalid answer index');
      continue;
    }
    const segmentIds = [...new Set(fact.segmentIds)].filter((id) => known.has(id));
    if (!segmentIds.length) {
      drop(q, 'cites no existing transcript segment');
      continue;
    }
    const check = checkQuote(fact.quote, segmentIds, segments, threshold);
    if (!check.ok) {
      drop(q, `supporting quote could not be verified (${check.reason})`);
      continue;
    }
    const shuffled = shuffleOptions(options, q.answerIndex, q.question);
    questions.push({
      id: `Q${idOffset + questions.length + 1}`,
      question: q.question.trim(),
      options: shuffled.options,
      answerIndex: shuffled.answerIndex,
      explanation: q.explanation.trim(),
      quote: fact.quote.trim(),
      segmentIds,
      difficulty: q.difficulty,
    });
  }

  const errors = dropped.map((d) => `Question "${d.question.slice(0, 60)}" was rejected: ${d.reason}.`);
  if (questions.length < minQuestions) {
    errors.push(`Only ${questions.length} question(s) passed verification; at least ${minQuestions} are needed. Use exact quotes from the transcript.`);
    return { value: null, errors };
  }
  return { value: { questions, dropped }, errors };
}

async function writeQuestions({ segments, chapters, questionCount, difficulty, extraInstruction, config, providers, progress, signal, minQuestions, idOffset = 0 }) {
  const user = quizPrompt({ segments, chapters, questionCount, difficulty, extraInstruction });
  const eta = estimateLlmSeconds(user.length) + 5;
  const stop = startEstimate(progress, eta);
  try {
    const result = await generateStructured({
      task: 'quiz',
      system: QUIZ_SYSTEM,
      user,
      schema: LLM_Quiz,
      validate: (d) => validateQuiz(d, segments, { threshold: config.quoteMatchThreshold, minQuestions, maxQuestions: questionCount, idOffset }),
      providers: [providers.primary, providers.secondary, providers.fallback],
      timeoutMs: config.llmTimeoutMs,
      progress,
      signal,
      shrink: (maxTokens) =>
        fitTranscriptPrompt(segments, (segs) => quizPrompt({ segments: segs, chapters, questionCount, difficulty, extraInstruction }), maxTokens),
    });
    return { ...result.data, provider: result.provider };
  } finally {
    stop();
  }
}

const renumber = (questions) => questions.map((q, i) => ({ ...q, id: `Q${i + 1}` }));

/**
 * Call 2: facts-first quiz. Two layers of checking:
 *   1. code: every supporting quote must appear in the cited transcript segments (validateQuiz)
 *   2. independent judge, blind: it answers each question from the evidence without seeing the key;
 *      questions it answers differently, or finds unanswerable/ambiguous, are dropped
 * If too few questions survive, the missing ones are written once more and checked the same way.
 */
export async function generateQuiz({ segments, chapters, questionCount, difficulty = 'mixed', extraInstruction, config, providers, progress, signal }) {
  const deps = { config, providers };
  const minQuestions = Math.min(3, questionCount);
  progress.stage('writing_quiz', { etaSeconds: estimateLlmSeconds(segments.reduce((n, s) => n + s.text.length, 0)) + 5 });
  // Accept any questions whose quotes verified (a repair call happens only if none did); the refill below tops up the rest.
  const first = await writeQuestions({ segments, chapters, questionCount, difficulty, extraInstruction, config, providers, progress, signal, minQuestions: 1 });
  const dropped = [...first.dropped];
  progress.stage('checking_quotes', {
    message: `${first.questions.length} question${first.questions.length === 1 ? '' : 's'} have their quote in the transcript${
      first.dropped.length ? `; ${first.dropped.length} removed because their evidence could not be found` : ''
    }.`,
    percent: 100,
  });

  progress.stage('verifying', { message: 'Answering each question independently from its cited passage' });
  let check = await factCheckQuestions({ questions: first.questions, segments, deps, progress, signal });
  let questions = check.kept;
  dropped.push(...check.dropped);
  const statuses = [check.status];
  let checker = check.checker;

  // One refill if the quote check or the independent check left too few questions.
  if (questions.length < minQuestions && (check.dropped.length || first.dropped.length)) {
    const missing = questionCount - questions.length;
    progress.update({ message: `Writing ${missing} replacement question${missing === 1 ? '' : 's'}` });
    const avoid = `Do not repeat these questions:\n${questions.map((q) => `- ${q.question}`).join('\n') || '(none)'}\nAvoid these problems found in earlier questions:\n${[...first.dropped, ...check.dropped]
      .map((d) => `- ${d.reason}`)
      .join('\n')}\nCopy every quote word for word from the transcript.`;
    try {
      const refill = await writeQuestions({
        segments,
        chapters,
        questionCount: missing,
        difficulty,
        extraInstruction: [extraInstruction, avoid].filter(Boolean).join('\n\n'),
        config,
        providers,
        progress,
        signal,
        minQuestions: 1,
        idOffset: 100,
      });
      dropped.push(...refill.dropped);
      const recheck = await factCheckQuestions({ questions: refill.questions, segments, deps, progress, signal });
      questions = [...questions, ...recheck.kept];
      dropped.push(...recheck.dropped);
      statuses.push(recheck.status);
      checker ??= recheck.checker;
    } catch (err) {
      if (signal?.aborted) throw err;
      progress.notice(`Replacement questions could not be written (${err.message}).`, { level: 'warn' });
    }
  }

  const status = statuses.every((s) => s === 'checked') ? 'checked' : statuses.every((s) => s === 'unchecked') ? 'unchecked' : 'partial';
  const confirmed = questions.filter((q) => q.check === 'confirmed').length;
  progress.update({
    percent: 100,
    message:
      status === 'unchecked'
        ? 'Fact-checker unavailable; questions marked as not checked'
        : `${confirmed} of ${questions.length} answers confirmed independently${check.dropped.length ? `; ${dropped.length} questions removed in total` : ''}`,
  });

  return {
    quiz: { questions: renumber(questions), dropped, verification: verificationSummary({ status, checker }) },
    provider: first.provider,
  };
}
