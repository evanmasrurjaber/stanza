import { describe, it, expect } from 'vitest';
import { parseClock, formatClock, parseTimecodedText } from '../src/transcript/timecodes.js';
import { parseSubtitles, looksLikeSubtitles } from '../src/transcript/subtitles.js';
import { buildSegments, ingestTranscriptText, ingestWhisperSegments, splitSentences } from '../src/transcript/segmenter.js';

const words = (n, w = 'word') => Array.from({ length: n }, (_, i) => `${w}${i}`).join(' ');
const sentence = (n) => `${words(n - 1)} end.`;

describe('parseClock / formatClock', () => {
  it.each([
    ['12:34', 754],
    ['1:02:03', 3723],
    ['00:00:05.500', 5.5],
    ['00:01:02,250', 62.25],
    ['90:00', 5400],
  ])('%s -> %d', (s, v) => expect(parseClock(s)).toBeCloseTo(v));

  it.each(['12:60', '1:61:00', 'abc', '12', ''])('rejects %s', (s) => expect(parseClock(s)).toBeNull());

  it('formats', () => {
    expect(formatClock(5)).toBe('0:05');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(null)).toBeNull();
  });
});

describe('parseTimecodedText', () => {
  it('parses bracketed, parenthesised and bare stamps with speakers', () => {
    const text = '[00:00] Host: Welcome.\n(0:30) Guest - Thanks for having me.\ncontinued line\n01:15 Host: Next topic.';
    const units = parseTimecodedText(text);
    expect(units).toEqual([
      { start: 0, end: 30, text: 'Host: Welcome.' },
      { start: 30, end: 75, text: 'Guest - Thanks for having me. continued line' },
      { start: 75, end: null, text: 'Host: Next topic.' },
    ]);
  });

  it('returns null when there are too few stamps', () => {
    expect(parseTimecodedText('[00:10] one\nsome text')).toBeNull();
  });

  it('returns null when stamps are mostly out of order (not a real timeline)', () => {
    expect(parseTimecodedText('[05:00] a\n[01:00] b\n[04:00] c\n[00:30] d')).toBeNull();
  });

  it('attaches preamble before the first stamp to time 0', () => {
    const units = parseTimecodedText('Intro text\n[00:10] a\n[00:20] b\n[00:30] c');
    expect(units[0]).toMatchObject({ start: 0, text: 'Intro text' });
  });
});

describe('subtitles', () => {
  const srt = `1
00:00:01,000 --> 00:00:04,000
Hello <i>there</i>.

2
00:00:04,000 --> 00:00:07,500
Second cue.

3
00:00:07,500 --> 00:00:09,000
Second cue.`;

  const vtt = `WEBVTT

NOTE a comment

00:01.000 --> 00:04.000
<v Alice>Hi from VTT.

00:04.000 --> 00:06.000
More.`;

  it('detects and parses SRT, merging duplicate auto-caption cues', () => {
    expect(looksLikeSubtitles(srt)).toBe(true);
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 4, text: 'Hello there.' },
      { start: 4, end: 9, text: 'Second cue.' },
    ]);
  });

  it('parses VTT with voice tags', () => {
    expect(parseSubtitles(vtt)[0]).toEqual({ start: 1, end: 4, text: 'Alice: Hi from VTT.' });
  });

  it('does not treat prose containing an arrow as subtitles', () => {
    expect(looksLikeSubtitles('A --> B is a pointer')).toBe(false);
  });
});

describe('buildSegments', () => {
  it('assigns sequential IDs and keeps segments within word bounds', () => {
    const units = Array.from({ length: 30 }, (_, i) => ({ text: sentence(15), start: i * 5, end: i * 5 + 5 }));
    const segs = buildSegments(units);
    expect(segs.map((s) => s.id).slice(0, 3)).toEqual(['S0001', 'S0002', 'S0003']);
    for (const s of segs) expect(s.text.split(' ').length).toBeLessThanOrEqual(120);
    expect(segs[0].start).toBe(0);
    expect(segs.at(-1).end).toBe(150);
  });

  it('never invents times for pieces of a split long unit', () => {
    const long = Array.from({ length: 10 }, () => sentence(30)).join(' ');
    const segs = buildSegments([{ text: long, start: 100, end: 400 }]);
    expect(segs.length).toBeGreaterThan(1);
    expect(segs[0].start).toBe(100);
    expect(segs.slice(1).every((s) => s.start === null)).toBe(true);
  });

  it('chunks unpunctuated ASR text', () => {
    expect(splitSentences(words(300)).length).toBe(3);
  });
});

describe('ingestTranscriptText', () => {
  const opts = { maxChars: 200_000 };

  it('plain text has no timestamps and an estimated length', () => {
    const r = ingestTranscriptText(Array.from({ length: 20 }, () => sentence(20)).join('\n\n'), opts);
    expect(r.source).toBe('plain');
    expect(r.hasTimestamps).toBe(false);
    expect(r.durationSec).toBeNull();
    expect(r.segments.every((s) => s.start === null)).toBe(true);
  });

  it('timecoded text keeps real times', () => {
    const text = Array.from({ length: 12 }, (_, i) => `[${String(i).padStart(2, '0')}:00] ${sentence(20)}`).join('\n');
    const r = ingestTranscriptText(text, opts);
    expect(r.source).toBe('timecodes');
    expect(r.hasTimestamps).toBe(true);
    expect(r.segments[0].start).toBe(0);
  });

  it('rejects empty, too long and too short input with clear messages', () => {
    expect(() => ingestTranscriptText('   ', opts)).toThrow(/empty/);
    expect(() => ingestTranscriptText('x'.repeat(11), { maxChars: 10 })).toThrow(/limit is 10/);
    expect(() => ingestTranscriptText('Too short.', opts)).toThrow(/too short/);
  });

  it('whisper segments become timed segments; empty audio is NO_SPEECH', () => {
    const r = ingestWhisperSegments([{ text: sentence(50), start: 0, end: 20 }]);
    expect(r).toMatchObject({ hasTimestamps: true, source: 'audio', durationSec: 20 });
    expect(() => ingestWhisperSegments([])).toThrow(expect.objectContaining({ code: 'NO_SPEECH' }));
  });
});
