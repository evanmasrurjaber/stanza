import { generateStructured } from '../llm/structured.js';
import { LLM_Overview } from '../schemas/index.js';
import { OVERVIEW_SYSTEM, overviewPrompt } from '../prompts/overview.js';
import { buildChapters, targetChapterCount } from './chapters.js';
import { transcriptStats } from '../transcript/segmenter.js';
import { estimateLlmSeconds, startEstimate } from '../lib/progress.js';

/** Keep only citations that point at real segments; drop takeaways left with none. */
export function cleanTakeaways(takeaways, segmentIds) {
  const known = new Set(segmentIds);
  const errors = [];
  const kept = [];
  for (const t of takeaways) {
    const ids = [...new Set(t.segmentIds)].filter((id) => known.has(id));
    if (ids.length < t.segmentIds.length) errors.push(`Takeaway "${t.text.slice(0, 40)}…" cited unknown segment IDs.`);
    if (!ids.length || !t.text.trim()) continue;
    kept.push({ text: t.text.trim(), segmentIds: ids });
  }
  return { kept, errors };
}

export function validateOverview(data, segments, { hasTimestamps }) {
  const errors = [];
  if (!data.summary.trim()) errors.push('summary is empty.');
  const { kept, errors: tErrors } = cleanTakeaways(data.takeaways, segments.map((s) => s.id));
  errors.push(...tErrors);
  if (!kept.length) errors.push('No takeaway cited a valid segment ID.');
  const chapters = buildChapters(data.chapters, segments, { hasTimestamps });
  errors.push(...chapters.errors);

  if (!data.summary.trim() || !kept.length || !chapters.value) return { value: null, errors };
  return {
    value: {
      summary: data.summary.trim(),
      themes: data.themes.map((t) => t.trim()).filter(Boolean).slice(0, 8),
      takeaways: kept,
      chapters: chapters.value,
    },
    errors,
  };
}

/** Call 1: summary, themes, takeaways and chapters in a single structured LLM call. */
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

  return {
    overview: result.data,
    hasTimestamps,
    timestampNote: hasTimestamps
      ? null
      : 'This transcript has no timecodes, so chapters are shown without times rather than with guessed ones.',
    provider: result.provider,
    warnings: result.warnings,
  };
}
