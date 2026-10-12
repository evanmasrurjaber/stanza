import { invalidInput, noSpeech } from '../lib/errors.js';
import { parseTimecodedText } from './timecodes.js';
import { looksLikeSubtitles, parseSubtitles } from './subtitles.js';

export const MIN_WORDS = 40;
export const MAX_WORDS = 120;
export const WORDS_PER_MINUTE = 150;

const wordCount = (s) => (s.match(/\S+/g) ?? []).length;
export const segmentId = (n) => `S${String(n).padStart(4, '0')}`;

/** Split prose into sentences; unpunctuated ASR text falls back to fixed-size word chunks. */
export function splitSentences(text, maxWords = MAX_WORDS) {
  const parts = text.split(/(?<=[.!?…]["')\]]?)\s+(?=["'(\[]?[A-Z0-9])/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const words = p.split(/\s+/);
    if (words.length <= maxWords) {
      out.push(p);
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords) out.push(words.slice(i, i + maxWords).join(' '));
  }
  return out;
}

/**
 * Turn timed or untimed units into evenly sized segments (S0001, S0002, ...).
 *
 * Timing rule: a segment's `start` is only set when the source gave a real time for the
 * beginning of that text. When a long timed unit has to be split, later pieces get
 * `start: null` rather than an interpolated (invented) time.
 */
export function buildSegments(units, { minWords = MIN_WORDS, maxWords = MAX_WORDS } = {}) {
  const pieces = [];
  for (const u of units) {
    const text = u.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const sentences = wordCount(text) > maxWords ? splitSentences(text, maxWords) : [text];
    sentences.forEach((s, i) => {
      pieces.push({
        text: s,
        words: wordCount(s),
        start: i === 0 ? (u.start ?? null) : null,
        end: i === sentences.length - 1 ? (u.end ?? null) : null,
      });
    });
  }

  const segments = [];
  let buf = [];
  let bufWords = 0;
  const flush = () => {
    if (!buf.length) return;
    segments.push({
      id: segmentId(segments.length + 1),
      text: buf.map((p) => p.text).join(' '),
      start: buf[0].start,
      end: buf[buf.length - 1].end,
    });
    buf = [];
    bufWords = 0;
  };

  for (const p of pieces) {
    if (bufWords > 0 && bufWords + p.words > maxWords) flush();
    buf.push(p);
    bufWords += p.words;
    if (bufWords >= minWords) flush();
  }
  // Fold a tiny tail into the previous segment instead of leaving a 5-word stub.
  if (buf.length && segments.length && bufWords < minWords / 2) {
    const last = segments[segments.length - 1];
    last.text += ` ${buf.map((p) => p.text).join(' ')}`;
    last.end = buf[buf.length - 1].end ?? last.end;
    buf = [];
  }
  flush();

  // Fill missing ends from the next segment's start when it is known (contiguous speech).
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i].end == null && segments[i + 1].start != null && segments[i].start != null) {
      segments[i].end = segments[i + 1].start;
    }
  }
  return segments;
}

export function transcriptStats(segments, hasTimestamps) {
  const words = segments.reduce((n, s) => n + wordCount(s.text), 0);
  let durationSec = null;
  if (hasTimestamps) {
    const last = [...segments].reverse().find((s) => s.end != null || s.start != null);
    durationSec = last ? (last.end ?? last.start) : null;
  }
  return {
    words,
    durationSec,
    // Used for chapter targeting when there are no real times; never shown as a timestamp.
    estimatedMinutes: durationSec != null ? durationSec / 60 : words / WORDS_PER_MINUTE,
  };
}

/**
 * Entry point for pasted / uploaded transcript text. Detects SRT/VTT, line timecodes, or plain text.
 */
export function ingestTranscriptText(raw, { maxChars }) {
  const text = String(raw ?? '').replace(/^﻿/, '');
  if (!text.trim()) throw invalidInput('The transcript is empty.');
  if (text.length > maxChars) {
    throw invalidInput(
      `The transcript is ${text.length.toLocaleString('en-US')} characters; the limit is ${maxChars.toLocaleString('en-US')} (about 3 hours of speech).`,
    );
  }

  let units;
  let source;
  if (looksLikeSubtitles(text)) {
    units = parseSubtitles(text);
    source = 'subtitles';
  }
  if (!units?.length) {
    units = parseTimecodedText(text);
    source = 'timecodes';
  }
  if (!units?.length) {
    units = text.split(/\n\s*\n/).map((p) => ({ text: p, start: null, end: null }));
    source = 'plain';
  }

  const segments = buildSegments(units);
  if (!segments.length) throw invalidInput('No readable text was found in the transcript.');
  const hasTimestamps = source !== 'plain';
  if (wordCount(text) < 150) {
    throw invalidInput('The transcript is too short to summarise (minimum about 150 words).');
  }
  return { segments, hasTimestamps, source, ...transcriptStats(segments, hasTimestamps) };
}

/** Whisper verbose_json segments → our segments. */
export function ingestWhisperSegments(whisperSegments) {
  const units = whisperSegments.map((s) => ({ text: s.text ?? '', start: s.start ?? null, end: s.end ?? null }));
  const segments = buildSegments(units);
  if (!segments.length) throw noSpeech('No speech was detected in the audio file.');
  return { segments, hasTimestamps: true, source: 'audio', ...transcriptStats(segments, true) };
}
