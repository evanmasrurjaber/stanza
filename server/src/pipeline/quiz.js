import { generateStructured } from '../llm/structured.js';
import { LLM_Quiz } from '../schemas/index.js';
import { QUIZ_SYSTEM, quizPrompt } from '../prompts/quiz.js';
import { checkQuote } from './quoteCheck.js';
import { estimateLlmSeconds, startEstimate } from '../lib/progress.js';

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

/** Call 2: facts-first quiz, verified against the transcript in code. */
export async function generateQuiz({ segments, chapters, questionCount, difficulty = 'mixed', extraInstruction, config, providers, progress, signal }) {
  const user = quizPrompt({ segments, chapters, questionCount, difficulty, extraInstruction });
  const eta = estimateLlmSeconds(user.length) + 5;
  progress.stage('writing_quiz', { etaSeconds: eta });
  const stop = startEstimate(progress, eta);
  let result;
  try {
    result = await generateStructured({
      task: 'quiz',
      system: QUIZ_SYSTEM,
      user,
      schema: LLM_Quiz,
      validate: (d) =>
        validateQuiz(d, segments, {
          threshold: config.quoteMatchThreshold,
          minQuestions: Math.min(3, questionCount),
          maxQuestions: questionCount,
        }),
      providers: [providers.primary, providers.fallback],
      timeoutMs: config.llmTimeoutMs,
      progress,
      signal,
    });
  } finally {
    stop();
  }

  const { questions, dropped } = result.data;
  progress.stage('checking_quotes', {
    message: `${questions.length} question${questions.length === 1 ? '' : 's'} verified against the transcript${
      dropped.length ? `; ${dropped.length} removed because their evidence could not be found` : ''
    }.`,
    percent: 100,
  });
  return { quiz: { questions, dropped }, provider: result.provider };
}
