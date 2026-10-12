import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import request from 'supertest';
import ffmpegPath from 'ffmpeg-static';
import { createApp } from '../src/app.js';
import { providerQuotaExhausted, providerUnavailable, providerRateLimited } from '../src/lib/errors.js';
import { fakeLlm, makeSegments, ndjson, overviewDraft, quizDraft, testConfig } from './helpers.js';

const segments = makeSegments(60);
const NDJSON = 'application/x-ndjson';
const noProviders = { primary: null, fallback: null, router: null, whisper: null };

function appWith(providers = {}, cfg = {}) {
  return createApp({ config: testConfig(cfg), providers: { ...noProviders, ...providers } });
}

/** A primary that answers each task with valid drafts. */
function happyPrimary() {
  return fakeLlm('Gemini', ({ schemaName, user }) => {
    if (schemaName === 'overview') return overviewDraft(segments);
    if (schemaName === 'quiz' || schemaName === 'revise_quiz_questions') {
      const n = Number(/exactly (\d+) questions/.exec(user)?.[1] ?? 4);
      const d = quizDraft(segments, Math.min(n, 4));
      d.questions.forEach((q) => (q.question = `${q.question} (revised)`));
      return d;
    }
    if (schemaName === 'revise_summary') return { summary: 'A much shorter summary.', themes: ['habits'] };
    if (schemaName === 'route') throw new Error('router should use the router provider');
    throw new Error(`unexpected task ${schemaName}`);
  });
}

async function baseResult() {
  const app = appWith({ primary: happyPrimary() });
  const ov = await request(app).post('/api/generate/overview').send({ segments, hasTimestamps: true });
  const qz = await request(app).post('/api/generate/quiz').send({ segments, chapters: ov.body.overview.chapters, questionCount: 4 });
  return { overview: ov.body.overview, quiz: qz.body.quiz, hasTimestamps: true };
}

describe('basics', () => {
  it('health is instant and reports configured providers', async () => {
    const res = await request(appWith({ primary: happyPrimary() })).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, providers: { primary: true, fallback: false, router: false, transcription: false } });
  });

  it('CORS allows only configured origins', async () => {
    const app = appWith();
    const ok = await request(app).options('/api/transcribe').set('Origin', 'http://allowed.test').set('Access-Control-Request-Method', 'POST');
    expect(ok.headers['access-control-allow-origin']).toBe('http://allowed.test');
    const bad = await request(app).get('/api/health').set('Origin', 'http://evil.test');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('unknown route and malformed JSON give structured input errors', async () => {
    const app = appWith();
    const nf = await request(app).get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND', category: 'input' });
    const bad = await request(app).post('/api/generate/overview').set('Content-Type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatchObject({ code: 'INVALID_INPUT', message: expect.stringMatching(/not valid JSON/) });
  });

  it('our own rate limit is reported as category "limit" with a retry time', async () => {
    const app = appWith({ primary: happyPrimary() }, { rateLimitPerMin: 1 });
    await request(app).post('/api/generate/overview').send({ segments });
    const res = await request(app).post('/api/generate/overview').send({ segments });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatchObject({ code: 'TOO_MANY_REQUESTS', category: 'limit', retryable: true });
    expect(res.body.error.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });
});

describe('POST /api/transcript', () => {
  it('accepts pasted text', async () => {
    const text = segments.map((s, i) => `[${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}] ${s.text}`).join('\n');
    const res = await request(appWith()).post('/api/transcript').send({ text });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ hasTimestamps: true, source: 'timecodes' });
    expect(res.body.segments[0].id).toBe('S0001');
  });

  it('accepts an .srt upload', async () => {
    const srt = segments
      .slice(0, 10)
      .map((s, i) => `${i + 1}\n00:00:${String(i * 5).padStart(2, '0')},000 --> 00:00:${String(i * 5 + 5).padStart(2, '0')},000\n${s.text}`)
      .join('\n\n');
    const res = await request(appWith()).post('/api/transcript').attach('file', Buffer.from(srt), 'ep.srt');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('subtitles');
  });

  it('rejects unsupported and binary files clearly', async () => {
    const pdf = await request(appWith()).post('/api/transcript').attach('file', Buffer.from('%PDF'), 'ep.pdf');
    expect(pdf.status).toBe(415);
    expect(pdf.body.error).toMatchObject({ code: 'UNSUPPORTED_FORMAT', category: 'input', message: expect.stringMatching(/txt, srt, vtt/) });
    const bin = await request(appWith()).post('/api/transcript').attach('file', Buffer.from([0, 1, 2, 0]), 'ep.txt');
    expect(bin.body.error.message).toMatch(/plain text/);
  });
});

describe('POST /api/generate/*', () => {
  it('overview returns chapters with times computed in code', async () => {
    const res = await request(appWith({ primary: happyPrimary() })).post('/api/generate/overview').send({ segments, hasTimestamps: true });
    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('Gemini');
    expect(res.body.overview.chapters[1]).toMatchObject({ id: 'C2', startSegmentId: 'S0007', start: 180 });
    expect(res.body.timestampNote).toBeNull();
  });

  it('streams stage, progress and result events as NDJSON', async () => {
    const res = await request(appWith({ primary: happyPrimary() }))
      .post('/api/generate/overview')
      .set('Accept', NDJSON)
      .send({ segments, hasTimestamps: false });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(NDJSON);
    const events = ndjson(res.text);
    expect(events[0]).toMatchObject({ type: 'stage', stage: 'summarizing', label: expect.any(String), etaSeconds: expect.any(Number) });
    const last = events.at(-1);
    expect(last.type).toBe('result');
    expect(last.data.timestampNote).toMatch(/no timecodes/);
    expect(last.data.overview.chapters.every((c) => c.start === null)).toBe(true);
  });

  it('announces fallback to the backup provider in the stream', async () => {
    const primary = fakeLlm('Gemini', () => {
      throw providerQuotaExhausted('Gemini', 'daily request limit reached');
    });
    const fallback = fakeLlm('Groq', () => overviewDraft(segments));
    const res = await request(appWith({ primary, fallback })).post('/api/generate/overview').set('Accept', NDJSON).send({ segments });
    const events = ndjson(res.text);
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toMatchObject({ level: 'warn', provider: 'Gemini', message: expect.stringMatching(/quota.*Switching to the backup provider \(Groq\)/) });
    expect(events.at(-1).data.provider).toBe('Groq');
  });

  it('reports every provider failure with category, stage and per-provider attempts', async () => {
    const primary = fakeLlm('Gemini', () => {
      throw providerUnavailable('Gemini', 'HTTP 503');
    });
    const fallback = fakeLlm('Groq', () => {
      throw providerRateLimited('Groq', 120_000);
    });
    const app = appWith({ primary, fallback });

    const json = await request(app).post('/api/generate/overview').send({ segments });
    expect(json.status).toBe(503);
    expect(json.body.error).toMatchObject({
      code: 'ALL_PROVIDERS_FAILED',
      category: 'provider',
      stage: 'summarizing',
      retryable: true,
      attempts: [
        { provider: 'Gemini', code: 'PROVIDER_UNAVAILABLE' },
        { provider: 'Groq', code: 'PROVIDER_RATE_LIMITED' },
      ],
    });

    const streamed = ndjson((await request(app).post('/api/generate/overview').set('Accept', NDJSON).send({ segments })).text);
    expect(streamed.at(-1)).toMatchObject({ type: 'error', status: 503, error: { code: 'ALL_PROVIDERS_FAILED', stage: 'summarizing' } });
  }, 20_000);

  it('a misconfigured key is a server error, not the user\'s fault', async () => {
    const res = await request(appWith()).post('/api/generate/overview').send({ segments });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatchObject({ code: 'NO_PROVIDER_CONFIGURED', category: 'server' });
  });

  it('quiz returns verified questions and the checking stage reports counts', async () => {
    const app = appWith({ primary: happyPrimary() });
    const { body } = await request(app).post('/api/generate/overview').send({ segments, hasTimestamps: true });
    const res = await request(app).post('/api/generate/quiz').set('Accept', NDJSON).send({ segments, chapters: body.overview.chapters, questionCount: 4 });
    const events = ndjson(res.text);
    expect(events.find((e) => e.stage === 'checking_quotes' && e.type === 'stage').message).toMatch(/4 questions verified/);
    expect(events.at(-1).data.quiz.questions).toHaveLength(4);
  });

  it('quiz rejects chapters that do not belong to the transcript', async () => {
    const chapters = [{ id: 'C1', startSegmentId: 'S0001', endSegmentId: 'S9999', title: 't', explanation: '', start: null, end: null }];
    const res = await request(appWith({ primary: happyPrimary() })).post('/api/generate/quiz').send({ segments, chapters });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/revise', () => {
  let result;
  beforeAll(async () => {
    result = await baseResult();
  });

  it('preset changes only the summary', async () => {
    const res = await request(appWith({ primary: happyPrimary() })).post('/api/revise').send({ preset: 'shorter_summary', result, segments });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ action: 'revise', changed: ['summary'] });
    expect(res.body.result.overview.summary).toBe('A much shorter summary.');
    expect(res.body.result.overview.chapters).toEqual(result.overview.chapters);
    expect(res.body.result.quiz).toEqual(result.quiz);
  });

  it('free-text request is routed to one question and only that question changes', async () => {
    const router = fakeLlm('Groq', () => ({
      action: 'revise',
      targets: [{ section: 'quiz', ids: ['Q2'] }],
      instruction: 'Make Q2 harder.',
      questionCount: null,
      clarifyQuestion: null,
      rejectReason: null,
    }));
    const res = await request(appWith({ primary: happyPrimary(), router }))
      .post('/api/revise')
      .set('Accept', NDJSON)
      .send({ request: 'make question 2 harder', result, segments });
    const events = ndjson(res.text);
    expect(events.filter((e) => e.type === 'stage').map((e) => e.stage)).toEqual(['routing', 'revising']);
    const out = events.at(-1).data;
    expect(out.changed).toEqual(['quiz:Q2']);
    const [before, after] = [result.quiz.questions, out.result.quiz.questions];
    expect(after[1].id).toBe('Q2');
    expect(after[1].question).toMatch(/revised/);
    expect([after[0], after[2], after[3]]).toEqual([before[0], before[2], before[3]]);
    expect(out.result.overview).toEqual(result.overview);
    // The request reaches the router quoted as data.
    expect(router.calls[0].user).toMatch(/<user_request>\nmake question 2 harder\n<\/user_request>/);
  });

  it('returns reject and clarify decisions without changing anything', async () => {
    const reject = fakeLlm('Groq', () => ({ action: 'reject', targets: [], instruction: '', questionCount: null, clarifyQuestion: null, rejectReason: 'Poems are out of scope.' }));
    const r1 = await request(appWith({ primary: happyPrimary(), router: reject })).post('/api/revise').send({ request: 'write a poem', result, segments });
    expect(r1.body).toEqual({ action: 'reject', rejectReason: 'Poems are out of scope.', clarifyQuestion: null });

    const vague = fakeLlm('Groq', () => ({ action: 'revise', targets: [], instruction: '', questionCount: null, clarifyQuestion: null, rejectReason: null }));
    const r2 = await request(appWith({ primary: happyPrimary(), router: vague })).post('/api/revise').send({ request: 'make it better', result, segments });
    expect(r2.body.action).toBe('clarify');
  });

  it('validates the request body', async () => {
    const res = await request(appWith()).post('/api/revise').send({ request: 'x', preset: 'shorter_summary', result, segments });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toMatch(/either a free-text request or a preset/);
  });
});

describe('POST /api/transcribe', () => {
  let wav;
  beforeAll(() => {
    wav = path.join(os.tmpdir(), `stanza-test-${process.pid}.wav`);
    const r = spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4', '-ac', '1', wav]);
    if (r.status !== 0) throw new Error(`could not create test audio: ${r.stderr}`);
  });

  const whisper = {
    name: 'Groq Whisper',
    model: 'test',
    async transcribe(file) {
      expect(fs.existsSync(file)).toBe(true);
      return { duration: 4, language: 'en', segments: segments.slice(0, 4).map((s, i) => ({ text: s.text, start: i, end: i + 1 })) };
    },
  };

  it('runs validate → probe → compress → transcribe → segment with progress, then cleans up', async () => {
    const before = new Set(fs.existsSync(path.join(os.tmpdir(), 'stanza-uploads')) ? fs.readdirSync(path.join(os.tmpdir(), 'stanza-uploads')) : []);
    const res = await request(appWith({ whisper })).post('/api/transcribe').set('Accept', NDJSON).attach('audio', wav, 'tone.wav');
    const events = ndjson(res.text);
    expect(events.filter((e) => e.type === 'stage').map((e) => e.stage)).toEqual(['validating', 'probing', 'compressing', 'transcribing', 'segmenting']);
    expect(events.some((e) => e.type === 'progress' && e.stage === 'compressing' && e.percent === 100)).toBe(true);
    const result = events.at(-1);
    expect(result.type).toBe('result');
    expect(result.data).toMatchObject({ hasTimestamps: true, source: 'audio', provider: 'Groq Whisper' });
    const after = fs.readdirSync(path.join(os.tmpdir(), 'stanza-uploads')).filter((f) => !before.has(f));
    expect(after).toEqual([]);
  }, 30_000);

  it('rejects a text file renamed to .mp3 by its content', async () => {
    const res = await request(appWith({ whisper })).post('/api/transcribe').attach('audio', Buffer.from('just some text, not audio'), 'fake.mp3');
    expect(res.status).toBe(415);
    expect(res.body.error).toMatchObject({ code: 'UNSUPPORTED_FORMAT', category: 'input', stage: 'validating' });
  });

  it('rejects audio over the duration limit before spending transcription quota', async () => {
    let called = false;
    const spy = { ...whisper, transcribe: async () => (called = true) };
    const app = createApp({ config: { ...testConfig(), limits: { ...testConfig().limits, audioSeconds: 2 } }, providers: { ...noProviders, whisper: spy } });
    const res = await request(app).post('/api/transcribe').attach('audio', wav, 'tone.wav');
    expect(res.status).toBe(422);
    expect(res.body.error).toMatchObject({ code: 'AUDIO_TOO_LONG', stage: 'probing' });
    expect(called).toBe(false);
  }, 30_000);

  it('rejects disallowed extensions before reading the upload', async () => {
    const res = await request(appWith({ whisper })).post('/api/transcribe').attach('audio', Buffer.from('x'), 'movie.exe');
    expect(res.status).toBe(415);
    expect(res.body.error.message).toMatch(/mp3, m4a, wav/);
  });
});
