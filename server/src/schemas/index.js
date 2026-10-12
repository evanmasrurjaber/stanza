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

export const LLM_Overview = z.object({
  summary: z.string(),
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
export const LLM_SummaryRevision = z.object({ summary: z.string(), themes: z.array(z.string()) });
export const LLM_TakeawaysRevision = z.object({ takeaways: z.array(LLM_Takeaway) });
export const LLM_ChapterTextRevision = z.object({
  chapters: z.array(z.object({ id: z.string(), title: z.string(), explanation: z.string() })),
});
export const LLM_ChaptersRevision = z.object({ chapters: z.array(LLM_ChapterDraft) });

// ---------- Final shapes (API responses, and input to /revise) ----------
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
  themes: z.array(z.string().max(300)).max(20),
  takeaways: z.array(z.object({ text: z.string().max(1000), segmentIds: z.array(SegmentIdSchema).max(20) })).max(30),
  chapters: z.array(ChapterSchema).min(1).max(40),
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
});

export const QuizSchema = z.object({
  questions: z.array(QuestionSchema).max(30),
  dropped: z.array(z.object({ question: z.string(), reason: z.string() })).default([]),
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
