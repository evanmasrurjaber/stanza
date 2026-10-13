import { describe, it, expect } from 'vitest';
import { collectWords, mimeFor, parseOffset, wordsToSegments } from '../src/llm/geminiTranscribe.js';

/** Build an Interaction-shaped response from [word, start, end] triples with real byte offsets. */
function interaction(text, timed) {
  const annotations = [];
  let cursor = 0;
  for (const [word, start, end] of timed) {
    const idx = text.indexOf(word, cursor);
    const from = Buffer.byteLength(text.slice(0, idx), 'utf8');
    const to = from + Buffer.byteLength(word, 'utf8');
    cursor = idx + word.length;
    annotations.push({ type: 'word_info', text: word, start_offset: `${start}s`, end_offset: `${end}s`, start_index: from, end_index: to });
  }
  return { status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text, annotations }] }] };
}

describe('Gemini Transcribe helpers', () => {
  it('parses "12.340s" offsets', () => {
    expect(parseOffset('12.340s')).toBeCloseTo(12.34);
    expect(parseOffset(undefined)).toBeNull();
    expect(parseOffset('nope')).toBeNull();
  });

  it('maps file extensions to the MIME types the API lists', () => {
    expect(mimeFor('/tmp/x.part0.mp3')).toBe('audio/mp3');
    expect(mimeFor('/tmp/x.speech.ogg')).toBe('audio/ogg');
    expect(mimeFor('/tmp/x.webm')).toBe('audio/webm');
  });

  it('slices segment text from the transcript so punctuation survives, splitting at pauses', () => {
    const text = 'Hello there, friends. Welcome back!';
    const words = collectWords(
      interaction(text, [
        ['Hello', 0, 0.4],
        ['there', 0.5, 0.8],
        ['friends', 0.9, 1.4],
        ['Welcome', 3.0, 3.4],
        ['back', 3.5, 3.9],
      ]),
    );
    expect(wordsToSegments(words)).toEqual([
      { text: 'Hello there, friends', start: 0, end: 1.4 },
      { text: 'Welcome back', start: 3.0, end: 3.9 },
    ]);
  });

  it('uses byte offsets, so multi-byte scripts slice correctly', () => {
    const text = 'আমি বাংলায় কথা বলি।';
    const words = collectWords(
      interaction(text, [
        ['আমি', 0, 0.5],
        ['বাংলায়', 0.6, 1.2],
        ['কথা', 1.3, 1.6],
        ['বলি', 1.7, 2.0],
      ]),
    );
    expect(wordsToSegments(words)[0].text).toBe('আমি বাংলায় কথা বলি');
  });

  it('splits continuous speech at sentence ends and caps segment length', () => {
    const timed = [];
    let text = '';
    for (let i = 0; i < 60; i++) {
      const w = `w${i}`;
      text += i % 10 === 9 ? `${w}. ` : `${w} `;
      timed.push([w, i * 0.5, i * 0.5 + 0.4]);
    }
    const segs = wordsToSegments(collectWords(interaction(text, timed)));
    expect(segs.length).toBeGreaterThan(2);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(20.5);
    // Too short to break at the first sentence end (< 8 s); breaks at the next one, punctuation kept inside.
    expect(segs[0].text).toMatch(/^w0 .* w9\. .* w19$/);
  });

  it('ignores annotations without timing', () => {
    const res = { steps: [{ content: [{ type: 'text', text: 'hi', annotations: [{ type: 'word_info', text: 'hi' }] }] }] };
    expect(collectWords(res)).toEqual([]);
  });
});
