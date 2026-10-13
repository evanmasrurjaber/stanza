import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { generateStructured } from '../src/llm/structured.js';
import { fitTranscriptPrompt } from '../src/prompts/common.js';
import { createProgress } from '../src/lib/progress.js';
import { providerUnavailable } from '../src/lib/errors.js';
import { makeSegments } from './helpers.js';

const Schema = z.object({ answer: z.string() });
const fake = (name, respond, maxInputTokens = null) => {
  const calls = [];
  return { name, model: `${name}-m`, maxInputTokens, calls, async generateJson(a) { calls.push(a); return JSON.stringify(respond(a)); } };
};
const down = (name) => fake(name, () => { throw providerUnavailable(name, 'HTTP 503'); });

describe('fitTranscriptPrompt', () => {
  const segments = makeSegments(80);
  const build = (segs) => segs.map((s) => `[${s.id}] ${s.text}`).join('\n');

  it('returns the full prompt when it already fits', () => {
    expect(fitTranscriptPrompt(segments.slice(0, 2), build, 10_000)).toBe(build(segments.slice(0, 2)));
  });

  it('trims every paragraph evenly, keeping all IDs and verbatim word prefixes', () => {
    const out = fitTranscriptPrompt(segments, build, 1500);
    expect(Math.ceil(out.length / 4)).toBeLessThanOrEqual(1500);
    for (const s of segments) expect(out).toContain(`[${s.id}] ${s.text.split(' ').slice(0, 6).join(' ')}`);
  });

  it('returns null when even a few words per paragraph cannot fit', () => {
    expect(fitTranscriptPrompt(segments, build, 50)).toBeNull();
  });
});

describe('generateStructured chain with a second Gemini model and a shrinking backup', () => {
  const base = { task: 't', system: 'sys', schema: Schema, timeoutMs: 1000, backoff: { attempts: 1 } };

  it('tries the second Gemini model when the first returns 503', async () => {
    const second = fake('Gemini (gemini-3.1-flash-lite)', () => ({ answer: 'ok' }));
    const out = await generateStructured({ ...base, user: 'u', providers: [down('Gemini'), second] });
    expect(out.provider).toBe('Gemini (gemini-3.1-flash-lite)');
  });

  it('gives the small-budget backup a shortened prompt instead of skipping it, and says so', async () => {
    const groq = fake('Groq', () => ({ answer: 'from groq' }), 100);
    const events = [];
    const out = await generateStructured({
      ...base,
      user: 'x'.repeat(4000),
      providers: [down('Gemini'), down('Gemini (gemini-3.1-flash-lite)'), groq],
      shrink: (max) => 'y'.repeat(max * 4 - 8),
      progress: createProgress((e) => events.push(e)),
    });
    expect(out.provider).toBe('Groq');
    expect(groq.calls[0].user).toMatch(/^y+$/);
    expect(events.some((e) => e.type === 'notice' && /shortened transcript/.test(e.message))).toBe(true);
  });

  it('still skips the backup when the prompt cannot be shortened enough', async () => {
    const groq = fake('Groq', () => ({ answer: 'x' }), 100);
    const err = await generateStructured({ ...base, user: 'x'.repeat(4000), providers: [down('Gemini'), groq], shrink: () => null }).catch((e) => e);
    expect(err.attempts.map((a) => a.code)).toEqual(['PROVIDER_UNAVAILABLE', 'SKIPPED_INPUT_TOO_LARGE']);
    expect(groq.calls).toHaveLength(0);
  });
});
