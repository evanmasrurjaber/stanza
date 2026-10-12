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
