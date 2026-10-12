import { loadConfig } from '../src/config.js';

export const TOPICS = ['sleep', 'coffee', 'exercise', 'memory', 'music', 'gardening', 'chess', 'oceans', 'robots', 'bread'];

/** n segments of ~50 words, one topic per 6 segments, each 30 s long when timed. */
export function makeSegments(n = 60, { timed = true } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const topic = TOPICS[Math.floor(i / 6) % TOPICS.length];
    const text =
      `In part ${i + 1} the host explains that ${topic} matters because fact number ${i + 1} shows a clear effect. ` +
      `The guest adds that researchers measured ${topic} in ${i + 10} volunteers over several weeks and found steady improvement. ` +
      `They both agree the lesson about ${topic} is simple and practical for listeners at home.`;
    return {
      id: `S${String(i + 1).padStart(4, '0')}`,
      text,
      start: timed ? i * 30 : null,
      end: timed ? (i + 1) * 30 : null,
    };
  });
}

export function testConfig(overrides = {}) {
  return { ...loadConfig({ NODE_ENV: 'test', ALLOWED_ORIGINS: 'http://allowed.test', RATE_LIMIT_PER_MIN: '100' }), ...overrides };
}

/** Fake chat provider: `respond(args)` returns an object (JSON-encoded), a string, or throws. */
export function fakeLlm(name, respond) {
  const calls = [];
  return {
    name,
    model: `${name}-test`,
    maxInputTokens: null,
    calls,
    async generateJson(args) {
      calls.push(args);
      const out = await respond(args, calls.length);
      return typeof out === 'string' ? out : JSON.stringify(out);
    },
  };
}

export function overviewDraft(segments) {
  return {
    summary: 'The hosts discuss many everyday topics and the evidence behind them.',
    themes: ['habits', 'evidence'],
    takeaways: [
      { text: 'Sleep matters.', segmentIds: ['S0001', 'S0002'] },
      { text: 'Coffee has a measurable effect.', segmentIds: ['S0007', 'S9999'] },
    ],
    chapters: Array.from({ length: Math.floor(segments.length / 6) }, (_, i) => ({
      startSegmentId: segments[i * 6].id,
      title: `About ${TOPICS[i % TOPICS.length]}`,
      explanation: `The hosts talk about ${TOPICS[i % TOPICS.length]}.`,
    })),
  };
}

export function quizDraft(segments, count = 4) {
  const facts = Array.from({ length: count }, (_, i) => {
    const seg = segments[i * 6];
    return { id: `F${i + 1}`, claim: 'claim', quote: seg.text.split('. ')[1], segmentIds: [seg.id] };
  });
  return {
    facts,
    questions: facts.map((f, i) => ({
      factId: f.id,
      question: `What did researchers measure in question ${i + 1}?`,
      options: ['Right answer', 'Wrong one', 'Also wrong', 'Nope'],
      answerIndex: 0,
      explanation: 'Because the guest said so.',
      difficulty: 'easy',
    })),
  };
}

/** Parse an NDJSON response body into events. */
export const ndjson = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
