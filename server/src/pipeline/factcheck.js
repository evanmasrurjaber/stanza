import { CODES } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { estimateTokens, generateStructured } from '../llm/structured.js';
import { LLM_ClaimRepairs, LLM_ClaimVerdicts, LLM_QuizVerdicts } from '../schemas/index.js';
import {
  CLAIM_JUDGE_SYSTEM,
  QUIZ_JUDGE_SYSTEM,
  REPAIR_SYSTEM,
  claimJudgePrompt,
  quizJudgePrompt,
  repairPrompt,
} from '../prompts/verify.js';

/*
 * Semantic fact-checking layer.
 *
 * Code already guarantees that citations exist and that quiz quotes appear in the transcript.
 * What code can't judge is whether a sentence is actually *supported* by what it cites, or whether
 * a quote really proves the marked answer. An independent model (Groq gpt-oss-20b by default,
 * a different model family from the Gemini writer) judges that, cheaply:
 *   - only the cited paragraphs (±1 neighbour) are sent, each once per batch, never the transcript
 *   - claims are batched so each call stays well under Groq's free 8K tokens/minute
 *   - the quiz is judged blind: the judge answers from the evidence without seeing the key
 *   - only flagged sentences are rewritten (one batched call), then re-judged; failures are removed
 * If the judge is unavailable, content is kept and labelled "unchecked" instead of failing.
 */

// Evidence tokens per judge call. With claims, output and reasoning this keeps a call around 4K tokens.
export const EVIDENCE_TOKEN_BUDGET = 2400;
const NEIGHBOURS = 1;

const REASON_TEXT = {
  overstated: 'overstates what the transcript says',
  unsupported: "isn't supported by the part of the transcript it cites",
  contradicted: 'contradicts the transcript',
};

function citedEvidence(ids, segments, index) {
  const picked = new Set();
  for (const id of ids) {
    const i = index.get(id);
    if (i === undefined) continue;
    for (let j = i - NEIGHBOURS; j <= i + NEIGHBOURS; j++) if (j >= 0 && j < segments.length) picked.add(j);
  }
  return picked;
}

/** Greedy batching: add items while the union of their evidence fits the token budget. */
export function batchByEvidence(items, segments, budget = EVIDENCE_TOKEN_BUDGET) {
  const index = new Map(segments.map((s, i) => [s.id, i]));
  const batches = [];
  let current = null;
  for (const item of items) {
    const own = citedEvidence(item.segmentIds, segments, index);
    if (current) {
      const union = new Set([...current.evidence, ...own]);
      const tokens = estimateTokens(...[...union].map((i) => segments[i].text));
      if (tokens <= budget) {
        current.items.push(item);
        current.evidence = union;
        continue;
      }
    }
    current = { items: [item], evidence: own };
    batches.push(current);
  }
  return batches.map((b) => ({ items: b.items, evidence: [...b.evidence].sort((a, z) => a - z).map((i) => segments[i]) }));
}

const judgeProviders = (deps) => [deps.providers.router, deps.providers.primary, deps.providers.secondary];
const writerProviders = (deps) => [deps.providers.primary, deps.providers.secondary, deps.providers.fallback];

const requireAllIds = (ids) => (d) => {
  const got = new Set(d.results.map((r) => r.id));
  const missing = ids.filter((id) => !got.has(id));
  return missing.length ? { value: null, errors: [`Missing results for: ${missing.join(', ')}`] } : { value: d, errors: [] };
};

/** Run one judge call; returns null when every judge provider fails (content then stays "unchecked"). */
async function judge({ task, system, user, schema, ids, deps, progress, signal }) {
  try {
    const out = await generateStructured({
      task,
      system,
      user,
      schema,
      validate: requireAllIds(ids),
      providers: judgeProviders(deps),
      timeoutMs: deps.config.llmTimeoutMs,
      temperature: 0,
      progress,
      signal,
      backoff: { maxWaitMs: 30_000 },
    });
    return { results: new Map(out.data.results.map((r) => [r.id, r])), checker: `${out.provider} ${out.model ?? ''}`.trim() };
  } catch (err) {
    if (err.code === CODES.CLIENT_ABORTED || signal?.aborted) throw err;
    logger.warn('fact-check judge unavailable', { task, code: err.code, message: err.message });
    progress.notice(`The fact-checker is unavailable: ${err.message} Content is shown, marked as not independently checked.`, {
      level: 'warn',
      provider: err.provider,
    });
    return null;
  }
}

/** Judge claims (any mix of summary sentences and takeaways). Returns verdict map + checker, or nulls for failed batches. */
export async function judgeClaims({ items, segments, deps, progress, signal }) {
  const verdicts = new Map();
  let checker = null;
  let failedBatches = 0;
  for (const batch of batchByEvidence(items, segments)) {
    const out = await judge({
      task: 'judge_claims',
      system: CLAIM_JUDGE_SYSTEM,
      user: claimJudgePrompt({ evidence: batch.evidence, claims: batch.items }),
      schema: LLM_ClaimVerdicts,
      ids: batch.items.map((i) => i.id),
      deps,
      progress,
      signal,
    });
    if (!out) {
      failedBatches++;
      continue;
    }
    checker ??= out.checker;
    for (const [id, v] of out.results) verdicts.set(id, v);
  }
  return { verdicts, checker, failedBatches };
}

async function repairClaims({ flagged, segments, deps, progress, signal }) {
  const fixes = new Map();
  for (const batch of batchByEvidence(flagged, segments)) {
    const allowed = new Set(batch.evidence.map((s) => s.id));
    try {
      const out = await generateStructured({
        task: 'repair_claims',
        system: REPAIR_SYSTEM,
        user: repairPrompt({ evidence: batch.evidence, items: batch.items }),
        schema: LLM_ClaimRepairs,
        validate: (d) => {
          const got = new Set(d.items.map((r) => r.id));
          const missing = batch.items.filter((i) => !got.has(i.id)).map((i) => i.id);
          return missing.length ? { value: null, errors: [`Missing items: ${missing.join(', ')}`] } : { value: d, errors: [] };
        },
        providers: writerProviders(deps),
        timeoutMs: deps.config.llmTimeoutMs,
        temperature: 0.2,
        progress,
        signal,
      });
      for (const r of out.data.items) {
        const ids = [...new Set(r.segmentIds)].filter((id) => allowed.has(id));
        fixes.set(r.id, { text: r.text.trim(), segmentIds: ids });
      }
    } catch (err) {
      if (err.code === CODES.CLIENT_ABORTED || signal?.aborted) throw err;
      logger.warn('claim repair failed', { code: err.code, message: err.message });
    }
  }
  return fixes;
}

/**
 * Full claim pipeline: judge → repair flagged (one batched call) → re-judge repaired → remove what still fails.
 * items: [{ id, section, text, segmentIds }] with unique ids.
 * Returns { items (kept, each with check), removed, repaired, status, checker }.
 */
export async function factCheckClaims({ items, segments, deps, progress, signal }) {
  if (!items.length) return { items, removed: [], repaired: 0, status: 'checked', checker: null };
  const first = await judgeClaims({ items, segments, deps, progress, signal });
  if (first.verdicts.size === 0) {
    return { items: items.map((i) => ({ ...i, check: 'unchecked' })), removed: [], repaired: 0, status: 'unchecked', checker: null };
  }

  const result = new Map(items.map((i) => [i.id, { ...i, check: first.verdicts.has(i.id) ? 'supported' : 'unchecked' }]));
  const flagged = items
    .filter((i) => first.verdicts.get(i.id) && first.verdicts.get(i.id).verdict !== 'supported')
    .map((i) => ({ ...i, verdict: first.verdicts.get(i.id).verdict, reason: first.verdicts.get(i.id).reason }));
  const removed = [];
  let repaired = 0;

  if (flagged.length) {
    progress.update({ message: `${flagged.length} sentence${flagged.length === 1 ? '' : 's'} flagged; correcting against the evidence` });
    const fixes = await repairClaims({ flagged, segments, deps, progress, signal });
    const candidates = flagged
      .map((f) => ({ ...f, fix: fixes.get(f.id) }))
      .filter((f) => f.fix?.text && f.fix.segmentIds.length)
      .map((f) => ({ id: f.id, section: f.section, text: f.fix.text, segmentIds: f.fix.segmentIds }));
    const second = candidates.length ? await judgeClaims({ items: candidates, segments, deps, progress, signal }) : { verdicts: new Map() };
    const candidateById = new Map(candidates.map((c) => [c.id, c]));

    for (const f of flagged) {
      const candidate = candidateById.get(f.id);
      const v2 = candidate ? second.verdicts.get(f.id) : null;
      if (candidate && v2?.verdict === 'supported') {
        result.set(f.id, { ...candidate, check: 'supported' });
        repaired++;
        continue;
      }
      const last = v2 ?? f;
      removed.push({ section: f.section, text: f.text, reason: `${REASON_TEXT[last.verdict] ?? 'could not be verified'}${last.reason ? `: ${last.reason}` : ''}` });
      result.delete(f.id);
    }
  }

  return {
    items: items.map((i) => result.get(i.id)).filter(Boolean),
    removed,
    repaired,
    status: first.failedBatches ? 'partial' : 'checked',
    checker: first.checker,
  };
}

/**
 * Blind quiz check: the judge answers each question from its cited evidence without seeing the key.
 * Kept: judge picks the marked answer. Dropped: a different answer, none, or several options fit.
 */
export async function factCheckQuestions({ questions, segments, deps, progress, signal }) {
  if (!questions.length) return { kept: [], dropped: [], status: 'checked', checker: null };
  const verdicts = new Map();
  let checker = null;
  let failed = 0;
  for (const batch of batchByEvidence(questions, segments)) {
    const out = await judge({
      task: 'judge_quiz',
      system: QUIZ_JUDGE_SYSTEM,
      user: quizJudgePrompt({ evidence: batch.evidence, questions: batch.items }),
      schema: LLM_QuizVerdicts,
      ids: batch.items.map((q) => q.id),
      deps,
      progress,
      signal,
    });
    if (!out) {
      failed++;
      continue;
    }
    checker ??= out.checker;
    for (const [id, v] of out.results) verdicts.set(id, v);
  }

  const kept = [];
  const dropped = [];
  for (const q of questions) {
    const v = verdicts.get(q.id);
    if (!v) {
      kept.push({ ...q, check: 'unchecked' });
      continue;
    }
    const marked = 'ABCD'[q.answerIndex];
    if (v.choice === marked) {
      kept.push({ ...q, check: 'confirmed' });
      continue;
    }
    const why =
      v.choice === 'none'
        ? "the cited part of the transcript doesn't answer it"
        : v.choice === 'multiple'
          ? 'more than one option fits the cited part of the transcript'
          : `an independent check picked a different answer (${v.choice}) from the evidence`;
    dropped.push({ question: q.question, reason: `${why}${v.reason ? `: ${v.reason}` : ''}` });
  }
  const status = verdicts.size === 0 ? 'unchecked' : failed ? 'partial' : 'checked';
  return { kept, dropped, status, checker };
}

export function verificationSummary({ status, checker, removed = [], repaired = 0 }) {
  const note =
    status === 'unchecked'
      ? 'The independent fact-checker was unavailable, so this content has not been checked against the transcript.'
      : status === 'partial'
        ? 'Part of this content could not be fact-checked because the checker was unavailable.'
        : null;
  return { status, checker, removed, repaired, note };
}

/** Combine the verification of a revised part with what was already there (different statuses → partial). */
export function mergeVerification(prev, next) {
  if (!prev) return next;
  const status = prev.status === next.status ? next.status : 'partial';
  return verificationSummary({ status, checker: next.checker ?? prev.checker, removed: next.removed, repaired: next.repaired });
}
