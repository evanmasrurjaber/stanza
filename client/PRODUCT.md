# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Anyone who listens to long-form podcasts and wants more from an episode than one passive listen. The user deliberately did not narrow this to one audience. Three situations are all in scope:
- learners studying an educational or interview episode, who want to understand it, find their way around it and test themselves;
- general listeners who want to skim an episode before or after listening, or find the moment something was said;
- creators who want a summary and chapters for their own episodes.

A second, critical audience is the **reviewers** at Thealon Animation Studios. They will open the live URL cold, probably on a sleeping free-tier server, paste or upload a sample, run the full workflow including one revision, and judge reliability, error handling and product judgment.

## Product Purpose

Stanza turns a podcast transcript or audio recording into an interactive companion:
- an overview (summary, themes, key takeaways);
- navigable chapters;
- a short quiz that checks understanding.

It also accepts plain-language revision requests that change only the part the user means. Success means the user can name the episode's main ideas, jump to the right section, and test their recall, all from content they can trust came from the episode.

## Positioning

Grounding is the product. Every chapter time comes from a real timestamp (Whisper, subtitle files or transcript timecodes), never from the model. Every quiz answer carries a verbatim quote that code has checked against the transcript; unverifiable questions are dropped and the user is told. Revisions are routed: the app edits only the targeted section, asks when a request is vague, and declines requests to add content that isn't in the episode.

## Operating Context

- Inputs: pasted transcript text; .txt/.srt/.vtt files; audio (mp3, m4a, wav, ogg, webm, flac) up to 200 MB and 2 hours.
- Long steps (transcription, generation) take seconds to minutes. The backend streams stage-by-stage progress, percent and ETA where known, plus notices about retries and provider fallback.
- The backend runs on a Render free instance that sleeps when idle and takes about a minute to wake. The UI must make this visible, not mysterious.
- Free AI tiers (Gemini, Groq) can hit rate limits or daily quotas. Errors arrive categorised as input, limit, provider or server, with the provider named. The user must always know what broke and whether retrying helps.
- Results live only in the browser. The user copies sections as plain text, or exports the edition as Markdown or PDF; nothing is stored on the server.
- API contract: `../docs/api.md`.

## Capabilities and Constraints

- Stateless server: the browser keeps the segments and results and sends them back for the quiz and for revisions.
- Revision presets: shorter summary, simpler summary, harder quiz, easier quiz, more chapters, fewer chapters. Free-text requests may return revise, clarify or reject.
- Chapters show no times when the source has none, with an explanation.
- Model output is untrusted and rendered as plain text only.
- Users should upload only content they have rights to; Gemini's free tier may use inputs to improve Google products. Both must be disclosed.

## Brand Commitments

Name: **Stanza**. No logo, palette or voice rules exist yet.

## Evidence on Hand

No sample episodes, screenshots, testimonials or usage data yet. Do not invent any. Demo content must be public or Creative Commons material that the user supplies.

## Product Principles

1. Trust is earned visibly: show where every answer comes from.
2. Never leave the user guessing: every wait has a stage name, and every failure says what broke and what to do.
3. Change only what was asked: revisions are surgical and reversible.
4. Reliable end to end beats feature count.

## Accessibility & Inclusion

No product-specific requirement was stated; target WCAG 2.2 AA. Progress and errors must be announced to assistive technology, not only drawn.
