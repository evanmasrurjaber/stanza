import { generateStructured } from '../llm/structured.js';
import {
  LLM_ChapterTextRevision,
  LLM_ChaptersRevision,
  LLM_Route,
  LLM_SummaryRevision,
  LLM_TakeawaysRevision,
} from '../schemas/index.js';
import {
  REVISER_SYSTEM,
  ROUTER_SYSTEM,
  buildOutline,
  chapterTextRevisionPrompt,
  chaptersResegmentPrompt,
  routerPrompt,
  summaryRevisionPrompt,
  takeawaysRevisionPrompt,
} from '../prompts/revise.js';
import { buildChapters } from './chapters.js';
import { cleanTakeaways } from './overview.js';
import { generateQuiz, validateQuiz } from './quiz.js';
import { QUIZ_SYSTEM, quizPrompt } from '../prompts/quiz.js';
import { LLM_Quiz } from '../schemas/index.js';
import { estimateLlmSeconds, startEstimate } from '../lib/progress.js';
import { invalidInput } from '../lib/errors.js';

export const MAX_TARGETS = 3;

/** Preset buttons skip the router: fixed, known-good routes. */
export const PRESET_ROUTES = {
  shorter_summary: { targets: [{ section: 'summary', ids: [] }], instruction: 'Make the summary about half as long, keeping the most important points.' },
  simpler_summary: { targets: [{ section: 'summary', ids: [] }], instruction: 'Rewrite the summary in simpler language a 14-year-old could follow. Keep it the same length or shorter.' },
  harder_quiz: { targets: [{ section: 'quiz', ids: [] }], instruction: 'Make the quiz questions harder.', difficulty: 'harder' },
  easier_quiz: { targets: [{ section: 'quiz', ids: [] }], instruction: 'Make the quiz questions easier.', difficulty: 'easier' },
  more_chapters: { targets: [{ section: 'chapters', ids: [] }], instruction: 'Split the episode into more, finer-grained chapters.', chapterDelta: 1.5 },
  fewer_chapters: { targets: [{ section: 'chapters', ids: [] }], instruction: 'Merge related chapters so there are fewer, broader chapters.', chapterDelta: 0.6 },
};

/**
 * The router model proposes; code disposes. Check the route against what actually exists and
 * downgrade anything unusable to a clarifying question instead of guessing.
 */
export function validateRoute(route, result, request) {
  if (route.action === 'reject') {
    return { action: 'reject', rejectReason: route.rejectReason?.trim() || 'That request is outside what this app can change.' };
  }
  if (route.action === 'clarify') {
    return { action: 'clarify', clarifyQuestion: route.clarifyQuestion?.trim() || 'Which part would you like to change: the summary, takeaways, chapters or quiz?' };
  }

  const chapterIds = new Set(result.overview.chapters.map((c) => c.id));
  const questionIds = new Set(result.quiz?.questions.map((q) => q.id) ?? []);
  if (!route.targets.length) {
    return { action: 'clarify', clarifyQuestion: 'Which part would you like to change: the summary, takeaways, chapters or quiz?' };
  }

  // Merge duplicate sections.
  const bySection = new Map();
  for (const t of route.targets) {
    const prev = bySection.get(t.section);
    bySection.set(t.section, prev ? { section: t.section, ids: prev.ids.length && t.ids.length ? [...prev.ids, ...t.ids] : [] } : { ...t });
  }
  const targets = [...bySection.values()];
  if (targets.length > MAX_TARGETS) {
    return { action: 'clarify', clarifyQuestion: `That changes ${targets.length} sections at once. Which ${MAX_TARGETS} should I start with?` };
  }

  for (const t of targets) {
    if (t.section === 'quiz' && !result.quiz?.questions.length) {
      return { action: 'reject', rejectReason: 'There is no quiz yet. Generate the quiz first, then ask for changes to it.' };
    }
    const known = t.section === 'chapters' ? chapterIds : t.section === 'quiz' ? questionIds : null;
    if (!known) {
      t.ids = [];
      continue;
    }
    const ids = [...new Set(t.ids.map((id) => id.trim().toUpperCase()))];
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) {
      const range = [...known];
      return {
        action: 'clarify',
        clarifyQuestion: `I couldn't find ${missing.join(', ')}. The available ${t.section === 'quiz' ? 'questions' : 'chapters'} are ${range[0]}–${range.at(-1)}. Which one did you mean?`,
      };
    }
    t.ids = ids;
  }

  return {
    action: 'revise',
    targets,
    instruction: route.instruction?.trim() || request,
    questionCount: route.questionCount && route.questionCount >= 3 && route.questionCount <= 12 ? route.questionCount : null,
  };
}

async function callLlm({ task, system, user, schema, validate, deps, progress, signal, providers }) {
  const eta = estimateLlmSeconds(user.length);
  const stop = startEstimate(progress, eta);
  try {
    const out = await generateStructured({
      task,
      system,
      user,
      schema,
      validate,
      providers: providers ?? [deps.providers.primary, deps.providers.fallback],
      timeoutMs: deps.config.llmTimeoutMs,
      progress,
      signal,
    });
    return out.data;
  } finally {
    stop();
  }
}

/** Revise one target and return a function that applies it to a result (pure merge). */
async function reviseTarget(target, ctx) {
  const { result, segments, instruction, deps, progress, signal, route } = ctx;
  const { overview } = result;
  const common = { deps, progress, signal, system: REVISER_SYSTEM };

  if (target.section === 'summary') {
    const data = await callLlm({
      ...common,
      task: 'revise_summary',
      user: summaryRevisionPrompt({ segments, overview, instruction }),
      schema: LLM_SummaryRevision,
      validate: (d) => (d.summary.trim() ? { value: d, errors: [] } : { value: null, errors: ['summary is empty'] }),
    });
    return { changed: ['summary'], apply: (r) => ({ ...r, overview: { ...r.overview, summary: data.summary.trim(), themes: data.themes.map((t) => t.trim()).filter(Boolean) } }) };
  }

  if (target.section === 'takeaways') {
    const data = await callLlm({
      ...common,
      task: 'revise_takeaways',
      user: takeawaysRevisionPrompt({ segments, overview, instruction }),
      schema: LLM_TakeawaysRevision,
      validate: (d) => {
        const { kept, errors } = cleanTakeaways(d.takeaways, segments.map((s) => s.id));
        return kept.length ? { value: kept, errors } : { value: null, errors: [...errors, 'No takeaway cited a valid segment ID.'] };
      },
    });
    return { changed: ['takeaways'], apply: (r) => ({ ...r, overview: { ...r.overview, takeaways: data } }) };
  }

  if (target.section === 'chapters' && target.ids.length) {
    const chapters = overview.chapters.filter((c) => target.ids.includes(c.id));
    const data = await callLlm({
      ...common,
      task: 'revise_chapter_text',
      user: chapterTextRevisionPrompt({ segments, chapters, instruction }),
      schema: LLM_ChapterTextRevision,
      validate: (d) => {
        const got = new Map(d.chapters.map((c) => [c.id, c]));
        const missing = target.ids.filter((id) => !got.get(id)?.title.trim());
        return missing.length ? { value: null, errors: [`Missing revised chapter(s): ${missing.join(', ')}`] } : { value: got, errors: [] };
      },
    });
    return {
      changed: target.ids.map((id) => `chapters:${id}`),
      apply: (r) => ({
        ...r,
        overview: {
          ...r.overview,
          chapters: r.overview.chapters.map((c) =>
            data.has(c.id) ? { ...c, title: data.get(c.id).title.trim(), explanation: data.get(c.id).explanation.trim() } : c,
          ),
        },
      }),
    };
  }

  if (target.section === 'chapters') {
    const current = overview.chapters.length;
    const targetChapters = route.chapterDelta ? Math.max(2, Math.round(current * route.chapterDelta)) : null;
    const chapters = await callLlm({
      ...common,
      task: 'revise_chapters',
      user: chaptersResegmentPrompt({ segments, chapters: overview.chapters, instruction, targetChapters }),
      schema: LLM_ChaptersRevision,
      validate: (d) => buildChapters(d.chapters, segments, { hasTimestamps: result.hasTimestamps }),
    });
    return { changed: ['chapters'], apply: (r) => ({ ...r, overview: { ...r.overview, chapters } }) };
  }

  // quiz
  const threshold = deps.config.quoteMatchThreshold;
  if (target.ids.length) {
    // Replace specific questions, keeping their IDs and the rest of the quiz untouched.
    const others = result.quiz.questions.filter((q) => !target.ids.includes(q.id));
    const replaced = result.quiz.questions.filter((q) => target.ids.includes(q.id));
    const extra = `${instruction}\n\nYou are replacing these questions:\n${replaced.map((q) => `- ${q.id}: ${q.question}`).join('\n')}\nDo not duplicate these existing questions:\n${others.map((q) => `- ${q.question}`).join('\n') || '(none)'}`;
    const user = quizPrompt({ segments, chapters: overview.chapters, questionCount: target.ids.length, difficulty: route.difficulty, extraInstruction: extra });
    const data = await callLlm({
      ...common,
      system: QUIZ_SYSTEM,
      task: 'revise_quiz_questions',
      user,
      schema: LLM_Quiz,
      validate: (d) => validateQuiz(d, segments, { threshold, minQuestions: 1, maxQuestions: target.ids.length }),
    });
    const fresh = new Map(target.ids.slice(0, data.questions.length).map((id, i) => [id, { ...data.questions[i], id }]));
    return {
      changed: [...fresh.keys()].map((id) => `quiz:${id}`),
      notes: fresh.size < target.ids.length ? [`Only ${fresh.size} of ${target.ids.length} questions could be replaced with verified ones; the rest were kept.`] : [],
      apply: (r) => ({ ...r, quiz: { ...r.quiz, questions: r.quiz.questions.map((q) => fresh.get(q.id) ?? q) } }),
    };
  }

  const questionCount = route.questionCount ?? Math.max(3, result.quiz.questions.length);
  const { quiz } = await generateQuiz({
    segments,
    chapters: overview.chapters,
    questionCount,
    difficulty: route.difficulty ?? 'mixed',
    extraInstruction: instruction,
    config: deps.config,
    providers: deps.providers,
    progress: { ...progress, stage: () => {} }, // stay in the "revising" stage
    signal,
  });
  return { changed: ['quiz'], apply: (r) => ({ ...r, quiz }) };
}

/**
 * Revision flow: route (router model or preset) → validate route → revise each target with the
 * same validators as first-pass generation → merge only the changed parts into a new result.
 */
export async function reviseResult({ request, preset, result, segments, deps, progress, signal }) {
  // The client sends segments with every call; make sure the result actually belongs to them.
  const segIds = new Set(segments.map((s) => s.id));
  if (result.overview.chapters.some((c) => !segIds.has(c.startSegmentId) || !segIds.has(c.endSegmentId))) {
    throw invalidInput('The result does not match the transcript that was sent.');
  }

  let route;
  if (preset) {
    route = { action: 'revise', ...structuredClone(PRESET_ROUTES[preset]) };
  } else {
    progress.stage('routing');
    const raw = await callLlm({
      task: 'route',
      system: ROUTER_SYSTEM,
      user: routerPrompt({ request, outline: buildOutline(result) }),
      schema: LLM_Route,
      deps,
      progress,
      signal,
      providers: [deps.providers.router, deps.providers.primary],
    });
    route = validateRoute(raw, result, request);
  }

  if (route.action !== 'revise') return { action: route.action, clarifyQuestion: route.clarifyQuestion ?? null, rejectReason: route.rejectReason ?? null };

  const labels = route.targets.map((t) => (t.ids.length ? `${t.section} (${t.ids.join(', ')})` : t.section));
  progress.stage('revising', { message: `Updating: ${labels.join(', ')}` });

  let next = result;
  const changed = [];
  const notes = [];
  const failed = [];
  let firstError = null;
  for (let i = 0; i < route.targets.length; i++) {
    if (route.targets.length > 1) progress.update({ message: `Revising ${labels[i]} (${i + 1} of ${route.targets.length})` });
    try {
      const out = await reviseTarget(route.targets[i], { result, segments, instruction: route.instruction, deps, progress, signal, route });
      next = out.apply(next);
      changed.push(...out.changed);
      notes.push(...(out.notes ?? []));
    } catch (err) {
      // With several targets, keep the parts that worked and report the part that didn't.
      if (route.targets.length === 1 || err.code === 'CLIENT_ABORTED' || !err.toJSON) throw err;
      firstError ??= err;
      failed.push({ target: labels[i], error: err.toJSON() });
      progress.notice(`Could not revise ${labels[i]}: ${err.message}`, { level: 'warn', provider: err.provider });
    }
  }
  if (!changed.length && firstError) throw firstError;

  return { action: 'revise', instruction: route.instruction, changed, notes, failed, result: next };
}
