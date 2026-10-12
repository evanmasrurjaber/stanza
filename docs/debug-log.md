# Debug log

Running notes on real problems found during development. The best entry becomes the README's "Debugging example".

## 2026-10-12 — Quote checker accepted a quote with a wrong number

**What went wrong.** The quiz grounding check compares each question's supporting quote with the cited transcript segments using normalised Levenshtein similarity (threshold 0.9). A unit test that cited the wrong segment expected a rejection, but the check passed.

**Investigation.** The test transcript used a repeated sentence template, so neighbouring segments differed only in a topic word and a number ("measured sleep in 13 volunteers" vs "measured coffee in 18 volunteers"). Over a ~100-character quote, those two edits still scored about 93% similarity. So a model could change a number or name in an otherwise real sentence and the check would accept it. Those are exactly the details a quiz question tests.

**Fix.** Character similarity is now only the first filter. The best-matching window must also:
1. contain every number-bearing token from the quote exactly, and
2. contain at least 80% of the quote's words verbatim. This still tolerates one or two ASR typos such as "volunters".

New tests cover a changed number (rejected) and ASR typos (accepted).

**Lesson.** A single global similarity score hides *which* characters differ. For grounding, a short changed token can carry the whole meaning, so high-information tokens (numbers) need exact checks.

## 2026-10-12 — Answer shuffle always produced the same position

`validateQuiz` shuffles options so the correct answer isn't always where the model put it (models favour the first options). The first version used a linear congruential generator with `seed % (i + 1)`. Its low bits cycle with a very short period, so similar question texts all landed on the same index. Replaced it with an FNV-1a hash seeding mulberry32, and added a test that asserts more than one answer position appears.

## 2026-10-13 — 47-minute MP3 took 15 minutes to "compress" on Render, and the instance went to sleep

**What went wrong.** After deploying, a 47 MB, 47-minute MP3 sat in "Compressing audio" for about 15 minutes. The Render free instance then spun down mid-job.

**Investigation.**
- On a laptop, re-encoding 10 minutes of MP3 to 16 kHz mono Opus took 3.1 s, and only 2.0 s with Opus `-compression_level 0`. The free instance's fraction of a CPU made that roughly 60× slower, so encoder tuning alone would still mean about 10 minutes.
- Splitting the same file with stream copy (`-c copy`, no re-encoding) took 0.3 s per 10 minutes.
- Render sleeps after 15 minutes without *incoming* requests. A single long request's streamed progress is outgoing traffic, so it doesn't keep the instance awake.

**Fix.**
1. **Compress in the browser.** Mediabunny drives the browser's native WebCodecs Opus encoder. Measured in Chromium: 10 minutes in 1.7 s, so a 47-minute episode takes about 8 s and comes out around 9 MB. The upload also shrinks about 5×.
2. **Server never re-encodes compressed audio.** Files under the provider limit pass straight through. Larger MP3/AAC/Opus files are cut into overlapping parts by stream copy and transcribed part by part. Timestamps are shifted by each part's offset and joined at the overlap midpoint. Re-encoding (fastest Opus setting) remains only for uncompressed WAV/FLAC that the browser couldn't shrink.
3. **Keep the instance awake.** While a job runs, the browser sends a tiny `/api/health` request every 4 minutes.

**Lesson.** On constrained hosting, measure where the CPU goes and move work to where it's cheap. Re-encoding was never needed: the provider only needs files under its size limit, and the user's device has far more spare compute than a free server.
