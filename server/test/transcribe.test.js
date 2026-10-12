import { describe, it, expect } from 'vitest';
import { CHUNK_OVERLAP_SEC, chunkWindows, planTranscription, stitchSegments } from '../src/pipeline/transcribe.js';

const MB = 1024 * 1024;
const limits = { maxBytes: 24 * MB, minChunkSec: 120 };

describe('planTranscription', () => {
  it('passes small files through untouched (e.g. already compressed in the browser)', () => {
    expect(planTranscription({ size: 8 * MB, duration: 2820, codec: 'opus', detectedExt: 'webm' }, limits)).toEqual({ mode: 'pass' });
  });

  it('splits a 47 MB / 47 min MP3 by stream copy instead of re-encoding', () => {
    const plan = planTranscription({ size: 47 * MB, duration: 2820, codec: 'mp3', detectedExt: 'mp3' }, limits);
    expect(plan.mode).toBe('split');
    expect(plan.chunks).toBe(3);
    expect(plan.ext).toBe('mp3');
  });

  it('re-encodes uncompressed audio that would need too many chunks', () => {
    // 47 min of 16-bit 44.1 kHz stereo WAV ≈ 475 MB → ~3 min chunks → too many requests.
    expect(planTranscription({ size: 190 * MB, duration: 2820, codec: 'pcm_s16le', detectedExt: 'wav' }, limits).mode).toBe('compress');
  });

  it('re-encodes when the container is not one the provider accepts', () => {
    expect(planTranscription({ size: 30 * MB, duration: 2820, codec: 'aac', detectedExt: 'aac' }, limits).mode).toBe('compress');
  });
});

describe('chunkWindows', () => {
  it('covers the whole duration with overlapping windows', () => {
    const w = chunkWindows(100, 40);
    expect(w).toEqual([
      { start: 0, duration: 40 + CHUNK_OVERLAP_SEC },
      { start: 40, duration: 40 + CHUNK_OVERLAP_SEC },
      { start: 80, duration: 20 },
    ]);
  });
});

describe('stitchSegments', () => {
  it('offsets chunk times and keeps exactly one copy of each overlapped moment', () => {
    const a = { offset: 0, segments: [{ text: 'a1', start: 0, end: 20 }, { text: 'a2', start: 20, end: 39 }, { text: 'a3 overlap', start: 40, end: 43 }] };
    const b = { offset: 40, segments: [{ text: 'b1 overlap', start: 0, end: 3 }, { text: 'b2', start: 3, end: 20 }] };
    const out = stitchSegments([a, b]);
    expect(out.map((s) => s.text)).toEqual(['a1', 'a2', 'a3 overlap', 'b2']);
    expect(out.map((s) => s.start)).toEqual([0, 20, 40, 43]);
  });
});
