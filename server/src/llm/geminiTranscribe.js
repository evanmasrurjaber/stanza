import path from 'node:path';
import { GoogleGenAI } from '@google/genai';
import { AppError, clientAborted, modelOutputInvalid, providerUnavailable } from '../lib/errors.js';
import { sleep } from '../lib/retry.js';
import { mapGeminiError } from './gemini.js';

export const GEMINI_TRANSCRIBE = 'Gemini Transcribe';

// Word timestamps cap a single request at 30 minutes of audio (1 hour without them).
export const GEMINI_TRANSCRIBE_MAX_SECONDS = 30 * 60;

const MIME = { mp3: 'audio/mp3', m4a: 'audio/m4a', mp4: 'audio/m4a', wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac', opus: 'audio/opus', aac: 'audio/aac' };
export const mimeFor = (file) => MIME[path.extname(file).slice(1).toLowerCase()] ?? 'audio/mpeg';

/** "12.340s" → 12.34 */
export const parseOffset = (v) => {
  if (v == null) return null;
  const n = Number(String(v).replace(/s$/, ''));
  return Number.isFinite(n) ? n : null;
};

/**
 * Pull word annotations out of an Interaction. Each word carries byte offsets into the text block it
 * belongs to, so segment text can be sliced from the real transcript (keeping punctuation) rather
 * than rebuilt from bare words.
 */
export function collectWords(interaction) {
  const words = [];
  for (const step of interaction?.steps ?? []) {
    for (const block of step?.content ?? []) {
      if (block?.type !== 'text' || !block.annotations?.length) continue;
      const bytes = Buffer.from(block.text ?? '', 'utf8');
      for (const a of block.annotations) {
        if (a?.type !== 'word_info') continue;
        const start = parseOffset(a.start_offset);
        if (start == null) continue;
        words.push({
          text: a.text ?? '',
          start,
          end: parseOffset(a.end_offset) ?? start,
          bytes,
          from: Number.isInteger(a.start_index) ? a.start_index : null,
          to: Number.isInteger(a.end_index) ? a.end_index : null,
        });
      }
    }
  }
  return words.sort((a, b) => a.start - b.start);
}

/**
 * Group timed words into Whisper-like segments: a new segment starts after a pause, after a
 * sentence end once the segment is long enough, or when it gets too long. Times are the words'
 * own times from the speech model.
 */
export function wordsToSegments(words, { pause = 1.0, sentenceAfter = 8, maxLen = 20 } = {}) {
  const segments = [];
  let cur = [];
  const flush = () => {
    if (!cur.length) return;
    const first = cur[0];
    const last = cur.at(-1);
    const sliceable = first.from != null && last.to != null && first.bytes === last.bytes && last.to > first.from;
    const text = sliceable ? last.bytes.subarray(first.from, last.to).toString('utf8') : cur.map((w) => w.text).join(' ');
    segments.push({ text: text.replace(/\s+/g, ' ').trim(), start: first.start, end: last.end });
    cur = [];
  };
  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur.at(-1).end;
      const len = cur.at(-1).end - cur[0].start;
      const prev = cur.at(-1);
      // Punctuation may be part of the word or sit just after it in the transcript text.
      const after = prev.to != null ? prev.bytes.subarray(prev.to, prev.to + 4).toString('utf8') : '';
      const sentenceEnded = /[.!?…]["')\]]?$/.test(prev.text) || /^["')\]]?[.!?…]/.test(after);
      if (gap > pause || len >= maxLen || (sentenceEnded && len >= sentenceAfter)) flush();
    }
    cur.push(w);
  }
  flush();
  return segments.filter((s) => s.text);
}

/** Resolve on abort so a hung SDK call can't outlive the request. */
const abortable = (promise, signal) =>
  !signal
    ? promise
    : Promise.race([
        promise,
        new Promise((_, reject) => {
          if (signal.aborted) reject(clientAborted());
          signal.addEventListener('abort', () => reject(clientAborted()), { once: true });
        }),
      ]);

/**
 * Gemini 3.5 Transcribe adapter (Interactions API). Same interface as the Groq Whisper adapter:
 *   transcribe(filePath, { signal }) → { segments: [{ text, start, end }], language, duration }
 */
export function createGeminiTranscribeProvider({ apiKey, model = 'gemini-3.5-transcribe' }) {
  const ai = new GoogleGenAI({ apiKey, httpOptions: { retryOptions: { attempts: 1 } } });

  async function waitUntilActive(file, signal) {
    let f = file;
    for (let i = 0; f.state === 'PROCESSING' && i < 60; i++) {
      await sleep(1000, signal);
      f = await ai.files.get({ name: f.name });
    }
    if (f.state === 'FAILED') throw providerUnavailable(GEMINI_TRANSCRIBE, 'the uploaded audio could not be processed');
    if (f.state === 'PROCESSING') throw providerUnavailable(GEMINI_TRANSCRIBE, 'the uploaded audio is still processing after a minute');
    return f;
  }

  return {
    name: GEMINI_TRANSCRIBE,
    model,
    maxChunkSeconds: GEMINI_TRANSCRIBE_MAX_SECONDS,
    async transcribe(filePath, { signal } = {}) {
      let uploaded = null;
      try {
        uploaded = await abortable(ai.files.upload({ file: filePath, config: { mimeType: mimeFor(filePath), abortSignal: signal } }), signal);
        uploaded = await waitUntilActive(uploaded, signal);
        const interaction = await abortable(
          ai.interactions.create(
            {
              model,
              input: [{ type: 'audio', uri: uploaded.uri, mime_type: uploaded.mimeType ?? mimeFor(filePath) }],
              generation_config: {
                // Verbatim mode with word timestamps: times come from the speech model, not from generated text.
                transcription_config: { mode: { type: 'verbatim', timestamp_granularities: ['word'] } },
              },
            },
            { signal, retries: { strategy: 'none' } },
          ),
          signal,
        );
        if (interaction?.status && interaction.status !== 'completed') {
          throw providerUnavailable(GEMINI_TRANSCRIBE, `the transcription ended with status "${interaction.status}"`);
        }
        const words = collectWords(interaction);
        if (!words.length) {
          // Text with no word timings would mean inventing times; reject instead.
          if (interaction?.output_text?.trim()) {
            throw modelOutputInvalid(GEMINI_TRANSCRIBE, `${GEMINI_TRANSCRIBE} returned text without word timestamps, so chapter times can't be trusted.`);
          }
          return { segments: [], language: null, duration: null };
        }
        return { segments: wordsToSegments(words), language: null, duration: words.at(-1).end };
      } catch (err) {
        if (signal?.aborted) throw clientAborted();
        if (err instanceof AppError) throw err;
        throw mapGeminiError(err, GEMINI_TRANSCRIBE);
      } finally {
        if (uploaded?.name) ai.files.delete({ name: uploaded.name }).catch(() => {});
      }
    },
  };
}
