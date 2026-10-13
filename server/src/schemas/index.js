import { z } from 'zod';

/*
 * Two kinds of schemas live here:
 *  - LLM_* schemas describe what we ask a model to return. They are converted to JSON Schema
 *    for provider-side enforcement, so they stay simple: no .optional() (Groq strict mode
 *    requires every key), no regex/refinements. Semantic checks happen in pipeline/ code.
 *  - Everything else validates data coming from the browser (untrusted) or leaving the API.
 */

// ---------- Shared ----------
export const SegmentIdSchema = z.string().regex(/^S\d{4,}$/, 'Segment IDs look like S0001');

export const SegmentSchema = z.object({
  id: SegmentIdSchema,
  text: z.string().min(1).max(5000),
  start: z.number().nonnegative().nullable(),
  end: z.number().nonnegative().nullable(),
});

export const SegmentsSchema = z.array(SegmentSchema).min(1).max(5000);

export const DIFFICULTIES = ['easy', 'medium', 'hard'];
export const SECTIONS = ['summary', 'takeaways', 'chapters', 'quiz'];

// ---------- LLM output: overview ----------
export const LLM_Takeaway = z.object({
  text: z.string(),
  segmentIds: z.array(z.string()),
});

export const LLM_ChapterDraft = z.object({
  startSegmentId: z.string(),
  title: z.string(),
  explanation: z.string(),
});

// A sentence or takeaway with the transcript segments it is based on (cited so it can be fact-checked).
export const LLM_Claim = z.object({
  text: z.string(),
  segmentIds: z.array(z.string()),
});

export const LLM_Overview = z.object({
  summary: z.array(LLM_Claim),
  themes: z.array(z.string()),
  takeaways: z.array(LLM_Takeaway),
  chapters: z.array(LLM_ChapterDraft),
});

// ---------- LLM output: quiz ----------
export const LLM_Fact = z.object({
  id: z.string(),
  claim: z.string(),
  quote: z.string(),
  segmentIds: z.array(z.string()),
});

export const LLM_Question = z.object({
  factId: z.string(),
  question: z.string(),
  options: z.array(z.string()),
  answerIndex: z.number().int(),
  explanation: z.string(),
  difficulty: z.enum(DIFFICULTIES),
});

export const LLM_Quiz = z.object({
  facts: z.array(LLM_Fact),
  questions: z.array(LLM_Question),
});

// ---------- LLM output: revision router ----------
export const LLM_Route = z.object({
  action: z.enum(['revise', 'clarify', 'reject']),
  targets: z.array(
    z.object({
      section: z.enum(SECTIONS),
      ids: z.array(z.string()),
    }),
  ),
  instruction: z.string(),
  questionCount: z.number().int().nullable(),
  clarifyQuestion: z.string().nullable(),
  rejectReason: z.string().nullable(),
});

// ---------- LLM output: section revisions ----------
export const LLM_SummaryRevision = z.object({ summary: z.array(LLM_Claim), themes: z.array(z.string()) });
export const LLM_TakeawaysRevision = z.object({ takeaways: z.array(LLM_Takeaway) });
export const LLM_ChapterTextRevision = z.object({
  chapters: z.array(z.object({ id: z.string(), title: z.string(), explanation: z.string() })),
});
export const LLM_ChaptersRevision = z.object({ chapters: z.array(LLM_ChapterDraft) });

// ---------- LLM output: fact-checking (judge) ----------
export const VERDICTS = ['supported', 'overstated', 'unsupported', 'contradicted'];
export const LLM_ClaimVerdicts = z.object({
  results: z.array(z.object({ id: z.string(), verdict: z.enum(VERDICTS), reason: z.string() })),
});
export const QUIZ_CHOICES = ['A', 'B', 'C', 'D', 'none', 'multiple'];
export const LLM_QuizVerdicts = z.object({
  results: z.array(z.object({ id: z.string(), choice: z.enum(QUIZ_CHOICES), reason: z.string() })),
});
export const LLM_ClaimRepairs = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string(), segmentIds: z.array(z.string()) })),
});

// ---------- Final shapes (API responses, and input to /revise) ----------
const CheckSchema = z.enum(['supported', 'unchecked']).optional();

export const VerificationSchema = z.object({
  status: z.enum(['checked', 'partial', 'unchecked']),
  checker: z.string().nullable(),
  removed: z.array(z.object({ section: z.string(), text: z.string(), reason: z.string() })).default([]),
  repaired: z.number().int().nonnegative().default(0),
  note: z.string().nullable().default(null),
});

const CitedSentenceSchema = z.object({
  text: z.string().max(1500),
  segmentIds: z.array(SegmentIdSchema).max(20),
  check: CheckSchema,
});
export const ChapterSchema = z.object({
  id: z.string().regex(/^C\d+$/),
  startSegmentId: SegmentIdSchema,
  endSegmentId: SegmentIdSchema,
  title: z.string().min(1).max(300),
  explanation: z.string().max(2000),
  start: z.number().nonnegative().nullable(),
  end: z.number().nonnegative().nullable(),
});

export const OverviewSchema = z.object({
  summary: z.string().min(1).max(10_000),
  summarySentences: z.array(CitedSentenceSchema).max(30).optional(),
  themes: z.array(z.string().max(300)).max(20),
  takeaways: z.array(CitedSentenceSchema).max(30),
  chapters: z.array(ChapterSchema).min(1).max(40),
  verification: VerificationSchema.optional(),
});

export const QuestionSchema = z.object({
  id: z.string().regex(/^Q\d+$/),
  question: z.string().min(1).max(1000),
  options: z.array(z.string().min(1).max(500)).length(4),
  answerIndex: z.number().int().min(0).max(3),
  explanation: z.string().max(2000),
  quote: z.string().max(2000),
  segmentIds: z.array(SegmentIdSchema).min(1).max(20),
  difficulty: z.enum(DIFFICULTIES),
  check: z.enum(['confirmed', 'unchecked']).optional(),
});

export const QuizSchema = z.object({
  questions: z.array(QuestionSchema).max(30),
  dropped: z.array(z.object({ question: z.string(), reason: z.string() })).default([]),
  verification: VerificationSchema.optional(),
});

export const ResultSchema = z.object({
  overview: OverviewSchema,
  quiz: QuizSchema.nullable(),
  hasTimestamps: z.boolean().default(false),
});

// ---------- Request bodies ----------
export const TranscriptBody = z.object({ text: z.string() });

export const GenerateOverviewBody = z.object({
  segments: SegmentsSchema,
  hasTimestamps: z.boolean().default(false),
});

export const GenerateQuizBody = z.object({
  segments: SegmentsSchema,
  chapters: z.array(ChapterSchema).min(1).max(40),
  questionCount: z.number().int().min(3).max(12).default(6),
});

export const PRESETS = ['shorter_summary', 'simpler_summary', 'harder_quiz', 'easier_quiz', 'more_chapters', 'fewer_chapters'];

export const ReviseBody = z
  .object({
    request: z.string().trim().max(500).optional(),
    preset: z.enum(PRESETS).optional(),
    result: ResultSchema,
    segments: SegmentsSchema,
  })
  .refine((b) => Boolean(b.request) !== Boolean(b.preset), {
    message: 'Provide either a free-text request or a preset, not both.',
  });
