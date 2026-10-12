# Stanza API contract

Base URL: `VITE_API_URL` (local `http://localhost:3000`, production = Render URL). All routes are under `/api`.
The server is **stateless**: the browser keeps `segments` and `result` and sends them back on each call.

## Typical flow (what the UI shows the user)

| Step | Call | Stages streamed |
|---|---|---|
| 0. Wake server | `GET /api/health` (poll every 3 s until 200) | – |
| 1a. Paste/upload transcript | `POST /api/transcript` | (instant) |
| 1b. *or* upload audio | `POST /api/transcribe` | validating → probing → compressing (real %) → transcribing (estimated %) → segmenting |
| 2. Overview | `POST /api/generate/overview` | summarizing (estimated %) |
| 3. Quiz | `POST /api/generate/quiz` | writing_quiz (estimated %) → checking_quotes |
| 4. Revisions | `POST /api/revise` | routing → revising |

The UI should show both the overall step ("Step 2 of 3") and the streamed stage label.
Upload progress for step 1b comes from the browser (`XMLHttpRequest.upload.onprogress`), because the server only starts streaming once it has received the whole file.

## Progress streaming (NDJSON)

Send `Accept: application/x-ndjson` (or `?stream=1`) to `/transcribe`, `/generate/*` or `/revise`. The response is `200` with one JSON object per line:

```jsonc
{"type":"stage","stage":"compressing","label":"Compressing audio","message":"Audio length 47:12","percent":0,"etaSeconds":null,"elapsedMs":812}
{"type":"progress","stage":"compressing","percent":42,"etaSeconds":9,"message":null,"estimated":false,"elapsedMs":4210}
{"type":"notice","stage":"summarizing","level":"warn","provider":"Gemini","message":"Gemini is receiving too many requests right now (rate limit). It asked us to wait 12 s. Retrying in 12 s (attempt 2 of 3)…","elapsedMs":9000}
{"type":"heartbeat","elapsedMs":20000}
{"type":"result","data":{ /* same body as the non-streaming response */ },"elapsedMs":31000}
// or, instead of result:
{"type":"error","status":503,"error":{ /* error object, see below */ },"elapsedMs":31000}
```

- `estimated: true` means the percentage is time-based, because the AI call gives no progress signal. Show it as approximate (for example "about 20 s left").
- `notice` events cover retries, fallbacks to the backup provider, and automatic repair attempts. Show them inline. They are not failures.
- Errors raised **before** streaming starts (our rate limit, upload size or extension, malformed body) come back as a normal non-200 JSON error. Always check `response.ok` and the `content-type` first.
- Closing the request (for example a Cancel button using `AbortController`) stops the server-side work, so no more AI quota is spent.

Without the NDJSON header, the same routes return plain JSON: `200` with the result, or an error status with the error body.

## Error object

Every error, whether a JSON body `{ "error": … }` or a streamed `{"type":"error","error":…}`, has this shape:

```jsonc
{
  "code": "ALL_PROVIDERS_FAILED",
  "category": "provider",          // input | limit | provider | server
  "message": "All AI providers failed. Gemini: Gemini's free usage quota is used up (daily request limit reached). Please try again later. Groq: Input (~52,000 tokens) exceeds Groq's free-tier budget (~5,000 tokens).",
  "provider": null,                // "Gemini" | "Groq" | "Groq Whisper" | null
  "stage": "summarizing",          // where it happened
  "retryable": false,
  "retryAfterSeconds": null,
  "attempts": [                    // only for fallback chains
    { "provider": "Gemini", "code": "PROVIDER_QUOTA_EXHAUSTED", "message": "…" },
    { "provider": "Groq", "code": "SKIPPED_INPUT_TOO_LARGE", "message": "…" }
  ],
  "details": []                    // optional: validation details
}
```

| category | Meaning for the user | Codes |
|---|---|---|
| `input` | Something about your file or text. Fix it and resubmit. | `INVALID_INPUT`, `FILE_TOO_LARGE`, `UNSUPPORTED_FORMAT`, `AUDIO_TOO_LONG`, `AUDIO_UNREADABLE`, `NO_SPEECH`, `NOT_FOUND` |
| `limit` | You hit this app's per-minute limit. Wait `retryAfterSeconds`. | `TOO_MANY_REQUESTS` |
| `provider` | An external AI service failed. `provider` says which one. | `PROVIDER_RATE_LIMITED` (busy, retry soon), `PROVIDER_QUOTA_EXHAUSTED` (free quota used up, try later), `PROVIDER_TIMEOUT` (not responding in time), `PROVIDER_UNAVAILABLE` (down or unreachable), `PROVIDER_REJECTED` (refused, e.g. safety filter), `MODEL_OUTPUT_INVALID` (answer failed our quality checks twice), `ALL_PROVIDERS_FAILED` (see `attempts`) |
| `server` | Our server is broken or misconfigured. Not the user's fault. | `INTERNAL`, `PROVIDER_AUTH` (server API key rejected), `NO_PROVIDER_CONFIGURED`, `AUDIO_PROCESSING_FAILED` |

Network-level failures never reach this format: a `fetch` rejection or no response at all. The UI should label them "Can't reach the server (it may be waking up or offline)" and fall back to the health-check banner.

## Endpoints

### `GET /api/health`
`{ ok: true, providers: { primary, fallback, router, transcription } }`. Instant, makes no AI calls, and is not rate limited.

### `GET /api/limits`
`{ transcript: { maxChars, fileExtensions }, audio: { maxMegabytes, maxSeconds, extensions }, rateLimitPerMinute }`. Display these next to the inputs.

### `POST /api/transcript`
JSON `{ text }` or multipart `file` (.txt/.srt/.vtt) →
`{ segments: Segment[], hasTimestamps, source: "plain"|"timecodes"|"subtitles", words, durationSec }`

`Segment = { id: "S0001", text, start: number|null, end: number|null }`

### `POST /api/transcribe`
multipart `audio` (mp3/m4a/wav/ogg/webm/flac) → same shape as `/transcript`, plus `language` and `provider`. The `source` is `"audio"`.

### `POST /api/generate/overview`
`{ segments, hasTimestamps }` → `{ overview, hasTimestamps, timestampNote, provider, warnings }`

`overview = { summary, themes[], takeaways[{ text, segmentIds[] }], chapters[{ id:"C1", startSegmentId, endSegmentId, title, explanation, start, end }] }`.
`start`/`end` are seconds computed from segment data. They are `null` when the source had no timestamps, and `timestampNote` explains why.

### `POST /api/generate/quiz`
`{ segments, chapters, questionCount? (3–12, default 6) }` → `{ quiz: { questions[], dropped[] }, provider }`

`question = { id:"Q1", question, options[4], answerIndex, explanation, quote, segmentIds[], difficulty }`. Every `quote` has been verified against the transcript. `dropped` lists the questions removed because their evidence could not be found.

### `POST /api/revise`
`{ request: string } | { preset }`, plus `result: { overview, quiz|null, hasTimestamps }` and `segments`.
Presets: `shorter_summary`, `simpler_summary`, `harder_quiz`, `easier_quiz`, `more_chapters`, `fewer_chapters`.

Responses:
- `{ action:"revise", instruction, changed:["summary","quiz:Q2",…], notes[], failed[], result }`: replace your result and keep the previous one for undo. `failed` lists targets that could not be revised when others succeeded.
- `{ action:"clarify", clarifyQuestion }`: show the question and let the user rephrase.
- `{ action:"reject", rejectReason }`: show the reason.
