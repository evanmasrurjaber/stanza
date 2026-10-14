# Stanza

Stanza is an AI podcast companion. It takes a podcast transcript or an audio file and turns it into a study edition: a summary, themes, key takeaways, chapters with real timestamps, and a multiple choice quiz. Every summary sentence, takeaway and quiz answer cites the transcript paragraph it came from, and an independent model checks them against those paragraphs. Users can ask for changes in plain words (for example "make question 2 harder"), and only the targeted part is rewritten. The edition can be copied or downloaded as PDF or Markdown.

Live: https://stanza-live.vercel.app/

## Stack

- **Frontend:** React 19 and Vite, deployed on Vercel. Audio is compressed in the browser with Mediabunny before upload. PDF export uses jsPDF.
- **Backend:** Node 22 and Express 5, deployed on Render. It is stateless, with no database. Zod validates inputs and model output, multer handles uploads, and ffmpeg (via `ffmpeg-static`) splits long audio.
- **AI models (free tiers):**
  - Google Gemini Flash writes the overview, quiz and revisions.
  - Groq `gpt-oss-120b` is the backup writer.
  - Groq `gpt-oss-20b` routes revision requests and fact-checks.
  - Groq Whisper transcribes audio, with Gemini Transcribe as its backup.
- **Tests:** Vitest and Supertest.

## Running locally

Requirements: Node 22 or newer, plus API keys from [Google AI Studio](https://aistudio.google.com/) and [Groq](https://console.groq.com/). ffmpeg ships as an npm package, so no system install is needed.

```bash
npm install
```

```bash
cp .env.example .env
```

Add `GEMINI_API_KEY` and `GROQ_API_KEY` to `.env`, then start the API on http://localhost:3000:

```bash
npm run dev
```

In a second terminal, start the frontend on http://localhost:5173. It proxies `/api` to the local API.

```bash
npm run dev:client
```

Run the tests:

```bash
npm test
```
