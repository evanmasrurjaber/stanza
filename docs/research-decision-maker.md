# MediaPipe Decision Maker spike (2026-10-13)

Model: `laya_s512.task` (float32, 679 MB) from `storage.googleapis.com/mediapipe-models/decision_maker/laya/...`.
Package: `@mediapipe/tasks-decision@1.1.0` (jsDelivr). Runtime: Claude desktop browser pane (Chromium 152), WebGPU available.
Test set: `factcheck-set.json`, 24 claim/evidence pairs and 6 quiz questions, all hand-labelled from the synthetic sample episode.

Method:
- Claims: `evaluateBoolean(evidence, { condition: "The text states or directly implies that: <claim>", threshold: 0.5 })`.
- Quiz: `evaluateChoice(evidence, { instructions: question, criteria: options })`.

## Speed
- Model load (download + init): 282.6 s. A ranged test of the same file measured about 0.9 MB/s on this connection.
- First check: 1.9 s (warm-up). After that: median 100 ms per check, max 110 ms.
- Docs' example model URLs (`decision_maker.task`, `embeddinggemma-2-270m-it.litertlm`) return 404. The bucket contains only `laya_s256/s512` (678–679 MB) and `gliner_s256/s512` (981 MB – 1.08 GB).

## Accuracy (claims, threshold 0.5; no other threshold did better)

| Kind | Correct |
|---|---|
| supported | 7/10 |
| changed number | 4/4 |
| contradiction | 3/5 |
| overstatement | 2/2 |
| unsupported (not mentioned) | 3/3 |
| **Total** | **19/24 (79%)** |

- **Let through 2 of 14 false claims.** Both were contradictions: #14 p = 0.573 and #18 p = 0.644.
- **Flagged 3 of 10 true claims.** #19 p = 0.446, #20 p = 0.246, #23 p = 0.415.
- **Poor separation.** All probabilities fall between 0.23 and 0.75. A false claim (#18, 0.644) outscored most true ones.

## Quiz (choice)
- **5/6 correct.**
- **Q6 failed on negation:** "What can a drone NOT do?" picked a capability the drone does have (p = 0.33).
- **Q3 was correct with no margin:** 0.33 vs 0.28 / 0.28. An ambiguity check based on these probabilities would be unreliable.

## Verdict
Very fast once loaded. But:
- the 679 MB first download takes minutes;
- 79% accuracy, with contradictions slipping through;
- negation fails.

Not suitable as Stanza's fact-checker.
