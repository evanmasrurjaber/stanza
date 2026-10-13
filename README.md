# Stanza: AI Podcast Companion

Turn a podcast transcript or recording into an overview, navigable chapters and a grounded quiz, then revise any part in plain English.

> Built for the Thealon Animation Studios AI Engineering Challenge ("From Audio to Insight").

- **Live app:** _TBD (Vercel frontend)_ · **API:** _TBD (Render)_
- **Demo video:** _TBD_

## What it does

1. **Input:** paste a transcript, upload `.txt/.srt/.vtt`, or upload audio (mp3/m4a/wav/ogg/webm/flac, up to 200 MB and 2 hours).
2. **Overview:** summary, themes and key takeaways, each takeaway citing transcript segments.
3. **Chapters:** the model picks where topics change and code builds the chapters. Times come only from real timestamps (the speech model's own word/segment times, SRT/VTT, or `[mm:ss]` timecodes). Without them, chapters are shown without times instead of with guessed ones.
4. **Quiz:** multiple-choice questions built from extracted facts. Each supporting quote is checked against the transcript in code, and unverifiable questions are dropped.
5. **Revision:** free-text requests ("make Q2 harder", "shorter summary") go through a small router model that revises only the targeted section, asks a clarifying question, or rejects out-of-scope requests. Preset buttons skip the router.
6. **Progress and errors:** long steps stream live progress (stage, percent, ETA, retry and fallback notices). Every error says whether the cause was the input, a rate limit, an AI provider, or the server. See [docs/api.md](docs/api.md).

## Architecture

```
Browser (React, Vercel) ──HTTPS + NDJSON progress──► Express API (Render)
                                                       │
  audio ─► (browser: Opus compress) ─► magic-byte check ─► ffprobe (≤ 2 h) ─► pass / stream-copy split ─► Groq Whisper (fallback: Gemini 3.5 Transcribe) ─┐
  text  ─► SRT/VTT/timecode/plain parser ──────────────────────────────────────────────────┤
                                                                                             ▼
                                                    numbered segments S0001… (+ real times)
                                                                                             │
             Gemini Flash (fallback: Groq gpt-oss-120b) ─► Zod schema ─► code validation ─► repair once
                  call 1: summary + takeaways + chapter starts   call 2: facts → quiz (quote-checked)
                                                                                             │
             revision: Groq gpt-oss-20b router ─► revise only the target section ─► same validators ─► merge
```

Key files:

| Area | File |
|---|---|
| Provider chain, retries, fallback, repair | [server/src/llm/structured.js](server/src/llm/structured.js) |
| Error taxonomy | [server/src/lib/errors.js](server/src/lib/errors.js) |
| Progress streaming | [server/src/lib/stream.js](server/src/lib/stream.js), [server/src/lib/progress.js](server/src/lib/progress.js) |
| Transcript parsing and segmentation | [server/src/transcript/](server/src/transcript/) |
| Chapter rules | [server/src/pipeline/chapters.js](server/src/pipeline/chapters.js) |
| Quote grounding | [server/src/pipeline/quoteCheck.js](server/src/pipeline/quoteCheck.js) |
| Revision router and merge | [server/src/pipeline/revise.js](server/src/pipeline/revise.js) |
| Audio pipeline | [server/src/pipeline/transcribe.js](server/src/pipeline/transcribe.js) |

## Running locally

Requirements: Node 22+. ffmpeg/ffprobe ship as npm packages, so no system install is needed.

```bash
npm install
cp .env.example .env      # add GEMINI_API_KEY and GROQ_API_KEY
npm run smoke -w server   # one tiny call per provider: checks keys, models, region
npm run dev               # API on http://localhost:3000
npm test                  # unit + integration tests (fake providers, real ffmpeg)
```

Keys:
- **Gemini:** [Google AI Studio](https://aistudio.google.com/). Free tier; do **not** link billing.
- **Groq:** [console.groq.com](https://console.groq.com/).

All model names are environment variables (see `.env.example`), because free-tier models change often.

## Deployment

- **API:** Render free web service from `render.yaml`. Set `GEMINI_API_KEY`, `GROQ_API_KEY` and `ALLOWED_ORIGINS` (the Vercel URL) in the dashboard.
- **Frontend:** Vercel, root directory `client`, with `VITE_API_URL` set to the Render URL.
- Render free instances sleep after 15 minutes idle. The frontend polls `/api/health` and shows a "server is waking up" banner.

## A. Tool and approach comparison
_TBD: summarised from the research notes (Gemini vs Groq, Groq Whisper vs AssemblyAI, Render vs Vercel, LLM vs embedding chapters, router vs dropdown), with sources._

## B. System architecture
See above. _TBD: expand after frontend._

## C. Debugging example
See [docs/debug-log.md](docs/debug-log.md): the quote checker accepted a quote whose number had been changed. _TBD: pick the final example._

## D. Reliability and limitations
_TBD. Already implemented: input limits, magic-byte checks, timeouts, backoff that honours provider retry hints, Gemini→Groq fallback, schema-enforced output plus one repair retry, quote verification, router output checked against real IDs, per-IP rate limiting, client-disconnect cancellation._

## E. Cost and maintenance
_TBD._

## Router evaluation
_TBD: output of `npm run eval:router -w server`._

## Next steps
1. Embedding-assisted chapter boundaries, measured against creator-published chapters.
2. Chunked transcription for episodes longer than 2 hours.
3. Semantic quiz verifier: a small model confirms each quote actually proves the marked answer.
