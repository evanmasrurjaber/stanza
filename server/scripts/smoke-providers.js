/**
 * Day-1 check: do the real API keys, model names, region and structured-output modes work?
 *   npm run smoke -w server        (reads ../.env)
 * Makes one tiny call per provider and prints latency or the mapped error.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { z } from 'zod';
import ffmpegPath from 'ffmpeg-static';
import { loadConfig } from '../src/config.js';
import { createProviders } from '../src/llm/providers.js';
import { generateStructured } from '../src/llm/structured.js';

const config = loadConfig();
const providers = createProviders(config);
const Schema = z.object({ capital: z.string(), confidence: z.enum(['low', 'high']), note: z.string().nullable() });

async function timed(label, fn) {
  const t = Date.now();
  try {
    const out = await fn();
    console.log(`✔ ${label} — ${Date.now() - t} ms`, JSON.stringify(out).slice(0, 160));
  } catch (err) {
    console.log(`✘ ${label} — ${Date.now() - t} ms`, err.toJSON ? JSON.stringify(err.toJSON()) : err.message);
    if (err.cause) console.log('   cause:', String(err.cause.message ?? err.cause).slice(0, 400));
  }
}

for (const slot of ['primary', 'fallback', 'router']) {
  const p = providers[slot];
  if (!p) {
    console.log(`– ${slot}: not configured`);
    continue;
  }
  await timed(`${slot} ${p.name} (${p.model}) structured JSON`, async () => {
    const r = await generateStructured({
      task: 'smoke',
      system: 'Answer briefly.',
      user: 'What is the capital of Bangladesh? Set note to null.',
      schema: Schema,
      providers: [p],
      timeoutMs: config.llmTimeoutMs,
      backoff: { attempts: 1 },
    });
    return r.data;
  });
}

if (providers.whisper) {
  const wav = path.join(os.tmpdir(), 'stanza-smoke.wav');
  spawnSync(ffmpegPath, ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '1', '-ar', '16000', wav]);
  await timed(`whisper ${providers.whisper.name} (${providers.whisper.model})`, async () => {
    const r = await providers.whisper.transcribe(wav);
    return { duration: r.duration, segments: r.segments.length, hasTimestamps: r.segments.every((s) => typeof s.start === 'number') };
  });
  fs.rmSync(wav, { force: true });
} else {
  console.log('– whisper: not configured');
}
