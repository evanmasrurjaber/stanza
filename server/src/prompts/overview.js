import { GROUNDING_RULES, formatTranscript } from './common.js';

export const OVERVIEW_SYSTEM = `You are an editor creating a study companion for a podcast episode.
${GROUNDING_RULES}`;

export function overviewPrompt({ segments, targetChapters }) {
  const first = segments[0].id;
  const last = segments.at(-1).id;
  return `${formatTranscript(segments)}

Create an episode overview as JSON:

1. "summary": a concise summary of the whole episode as 4–7 sentences (120–200 words in total), covering the beginning, middle and end. Each sentence is an object with "text" and "segmentIds": the 1–3 segment IDs that support it. Only write what those segments say.
2. "themes": 3–6 short phrases naming the main themes.
3. "takeaways": 4–7 of the most important, specific takeaways. Each has "text" (one or two sentences) and "segmentIds": the 1–3 segment IDs where it is discussed. Do not overstate: keep numbers, scope and certainty exactly as the speakers put them.
4. "chapters": about ${targetChapters} chapters that divide the episode at real topic changes.
   - "startSegmentId": the segment ID where the chapter's topic begins. The first chapter starts at ${first}. IDs must be in ascending order and between ${first} and ${last}.
   - "title": a descriptive title of at most 8 words (not "Introduction" unless it truly is one).
   - "explanation": 1–2 sentences on what is discussed in that chapter.
   A chapter ends where the next one starts, so only give start IDs.`;
}
