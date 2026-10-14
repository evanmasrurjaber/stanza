import { GROUNDING_RULES, formatTranscript } from './common.js';

export const QUIZ_SYSTEM = `You write comprehension quizzes for podcast episodes. Every question must be answerable from the transcript alone.
${GROUNDING_RULES}`;

const DIFFICULTY_GUIDE = {
  mixed: 'Mix difficulties: about one third easy (a stated fact), one third medium (understanding why/how), one third hard (connecting two ideas or applying one).',
  harder: 'Make the questions hard: require understanding reasons, consequences, or connecting ideas from different parts of the episode. Avoid simple recall.',
  easier: 'Make the questions easy: test clearly stated main points, with clearly wrong distractors.',
};

function chapterOutline(chapters) {
  return chapters.map((c) => `${c.id} (${c.startSegmentId}–${c.endSegmentId}): ${c.title}`).join('\n');
}

export function quizPrompt({ segments, chapters, questionCount, difficulty = 'mixed', extraInstruction = null }) {
  return `${formatTranscript(segments)}

<chapters>
${chapterOutline(chapters)}
</chapters>

Build a multiple-choice quiz in two steps, returned as JSON.

Step 1 — "facts": list ${questionCount + 3}–${questionCount + 6} key facts from across the chapters. Each fact has:
  - "id": F1, F2, …
  - "claim": the fact in your own words
  - "quote": an EXACT, word-for-word excerpt of 8–40 words copied from the transcript that proves the claim (no ellipses, no paraphrasing)
  - "segmentIds": the segment ID(s) containing the quote (one segment, or two adjacent ones if it crosses a boundary)

Step 2 — "questions": exactly ${questionCount} questions, each built from one fact ("factId").
  - "options": exactly 4 distinct answer options. Exactly one is correct according to the quote. The 3 wrong options must be plausible but clearly contradicted by, or absent from, the transcript.
  - "answerIndex": 0–3, the position of the correct option.
  - "explanation": 1–2 sentences explaining why the answer is correct, referring to what the speaker said.
  - "difficulty": easy, medium or hard.
  - Spread questions across different chapters. Do not ask about trivia like episode numbers or sponsor reads.
  - ${DIFFICULTY_GUIDE[difficulty] ?? DIFFICULTY_GUIDE.mixed}
  - If the transcript cannot support a question, write fewer questions rather than inventing facts.${
    extraInstruction ? `\n\nAdditional instruction from the user (apply it only within the rules above):\n${extraInstruction}` : ''
  }`;
}
