import { Router } from 'express';
import { streamable } from '../lib/stream.js';
import { GenerateOverviewBody, GenerateQuizBody } from '../schemas/index.js';
import { generateOverview } from '../pipeline/overview.js';
import { generateQuiz } from '../pipeline/quiz.js';
import { invalidInput } from '../lib/errors.js';

/** Throw if any chapter references a segment the client didn't send. */
function assertChaptersMatchSegments(chapters, segments) {
  const ids = new Set(segments.map((s) => s.id));
  const bad = chapters.find((c) => !ids.has(c.startSegmentId) || !ids.has(c.endSegmentId));
  if (bad) throw invalidInput(`Chapter ${bad.id} refers to segments that are not in this transcript.`);
}

export function generateRouter({ config, providers }) {
  const r = Router();

  r.post(
    '/overview',
    streamable(
      ({ req, progress, signal }) => {
        const { segments, hasTimestamps } = GenerateOverviewBody.parse(req.body ?? {});
        return generateOverview({ segments, hasTimestamps, config, providers, progress, signal });
      },
      { config },
    ),
  );

  r.post(
    '/quiz',
    streamable(
      ({ req, progress, signal }) => {
        const { segments, chapters, questionCount } = GenerateQuizBody.parse(req.body ?? {});
        assertChaptersMatchSegments(chapters, segments);
        return generateQuiz({ segments, chapters, questionCount, config, providers, progress, signal });
      },
      { config },
    ),
  );

  return r;
}
