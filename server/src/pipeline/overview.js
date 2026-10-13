import { generateStructured } from '../llm/structured.js';
import { LLM_Overview } from '../schemas/index.js';
import { OVERVIEW_SYSTEM, overviewPrompt } from '../prompts/overview.js';
import { buildChapters, targetChapterCount } from './chapters.js';
import { transcriptStats } from '../transcript/segmenter.js';
import { estimateLlmSeconds, startEstimate } from '../lib/progress.js';
import { factCheckClaims, verificationSummary } from './factcheck.js';

/** Keep only citations that point at real segments; drop sentences left with none. */
export function cleanCited(items, segmentIds, label = 'Takeaway') {
  const known = new Set(segmentIds);
  const errors = [];
  const kept = [];
  for (const t of items) {
    const ids = [...new Set(t.segmentIds)].filter((id) => known.has(id));
    if (ids.length < t.segmentIds.length) errors.push(`${label} "${t.text.slice(0, 40)}…" cited unknown segment IDs.`);
    if (!ids.length || !t.text.trim()) continue;
    kept.push({ text: t.text.trim(), segmentIds: ids });
  }
  return { kept, errors };
}
// Older name, still used by the revision pipeline and tests.
export const cleanTakeaways = (items, segmentIds) => cleanCited(items, segmentIds, 'Takeaway');

export const joinSummary = (sentences) => sentences.map((s) => s.text).join(' ');

export function validateOverview(data, segments, { hasTimestamps }) {
  const ids = segments.map((s) => s.id);
  const errors = [];
  const summary = cleanCited(data.summary, ids, 'Summary sentence');
  errors.push(...summary.errors);
  if (!summary.kept.length) errors.push('The summary has no sentence citing a valid segment ID.');
  const { kept, errors: tErrors } = cleanCited(data.takeaways, ids, 'Takeaway');
  errors.push(...tErrors);
  if (!kept.length) errors.push('No takeaway cited a valid segment ID.');
  const chapters = buildChapters(data.chapters, segments, { hasTimestamps });
  errors.push(...chapters.errors);

  if (!summary.kept.length || !kept.length || !chapters.value) return { value: null, errors };
  return {
    value: {
      summary: joinSummary(summary.kept),
      summarySentences: summary.kept,
      themes: data.themes.map((t) => t.trim()).filter(Boolean).slice(0, 8),
      takeaways: kept,
      chapters: chapters.value,
    },
    errors,
  };
}

/**
 * Fact-check summary sentences and takeaways together (one judge batch where the evidence fits).
 * A section is never emptied: if every item in it fails, the originals are kept but marked unchecked.
 */
export async function factCheckOverviewParts({ summarySentences, takeaways, segments, deps, progress, signal }) {
  const items = [
    ...(summarySentences ?? []).map((s, i) => ({ ...s, id: `SUM${i + 1}`, section: 'summary' })),
    ...(takeaways ?? []).map((t, i) => ({ ...t, id: `TK${i + 1}`, section: 'takeaways' })),
  ];
  const checked = await factCheckClaims({ items, segments, deps, progress, signal });
  const strip = ({ text, segmentIds, check }) => ({ text, segmentIds, check });
  const pick = (section, originals) => {
    if (!originals) return undefined;
    const kept = checked.items.filter((i) => i.section === section).map(strip);
    return kept.length ? kept : originals.map((o) => ({ ...o, check: 'unchecked' }));
  };
  return {
    summarySentences: pick('summary', summarySentences),
    takeaways: pick('takeaways', takeaways),
    verification: verificationSummary(checked),
  };
}

/** Call 1: summary, themes, takeaways and chapters in a single structured LLM call, then fact-checked. */
export async function generateOverview({ segments, hasTimestamps, config, providers, progress, signal }) {
  const { estimatedMinutes } = transcriptStats(segments, hasTimestamps);
  const targetChapters = targetChapterCount(estimatedMinutes, segments.length);
  const user = overviewPrompt({ segments, targetChapters });

  const eta = estimateLlmSeconds(user.length);
  progress.stage('summarizing', { etaSeconds: eta });
  const stop = startEstimate(progress, eta);
  let result;
  try {
    result = await generateStructured({
      task: 'overview',
      system: OVERVIEW_SYSTEM,
      user,
      schema: LLM_Overview,
      validate: (d) => validateOverview(d, segments, { hasTimestamps }),
      providers: [providers.primary, providers.fallback],
      timeoutMs: config.llmTimeoutMs,
      progress,
      signal,
    });
  } finally {
    stop();
  }

  const draft = result.data;
  progress.stage('verifying', { message: 'Checking each summary sentence and takeaway against the paragraphs it cites' });
  const checked = await factCheckOverviewParts({
    summarySentences: draft.summarySentences,
    takeaways: draft.takeaways,
    segments,
    deps: { config, providers },
    progress,
    signal,
  });
  const v = checked.verification;
  progress.update({
    percent: 100,
    message:
      v.status === 'unchecked'
        ? 'Fact-checker unavailable; content marked as not checked'
        : `Checked${v.repaired ? `, ${v.repaired} corrected` : ''}${v.removed.length ? `, ${v.removed.length} removed` : ''}`,
  });

  return {
    overview: {
      ...draft,
      summary: joinSummary(checked.summarySentences),
      summarySentences: checked.summarySentences,
      takeaways: checked.takeaways,
      verification: v,
    },
    hasTimestamps,
    timestampNote: hasTimestamps
      ? null
      : 'This transcript has no timecodes, so chapters are shown without times rather than with guessed ones.',
    provider: result.provider,
    warnings: result.warnings,
  };
}
