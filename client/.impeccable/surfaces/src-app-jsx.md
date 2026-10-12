---
version: 1
slug: "src-app-jsx"
primary_target: "src/App.jsx"
related_targets: []
---

# Surface: Stanza app (single-page workspace)

Mode: Operate. Audience: anyone studying, skimming or summarising a podcast episode, plus Thealon reviewers testing it cold on a sleeping free server. Task: supply a transcript or audio, wait through a visible process, then read, navigate, quiz yourself, revise and export. Constraints: stateless API (docs/api.md), NDJSON progress, categorised errors, plain-text rendering of model output, chapter-linked audio player for uploaded audio only.

## Direction contract

THESIS: The episode becomes an annotated study edition: numbered text, a contents page whose page numbers are timestamps, and every claim footnoted to its numbered paragraph. It refuses the AI-tool workspace of an input pane on the left, tabbed result cards on the right, and gradient sparkle.

OWN-WORLD: Saturated study-edition yellow (#F5C400) owns the edition band and the contents rail, set in black. White text stock carries the reading column. Ink is #141414 and margin numbers are grey #5E5E5E. Archivo (condensed weights for the band and heads) sits against Literata for reading. Paragraph numbers hang in the margin on one baseline grid. Contents uses dot leaders that end in times. Citations are pilcrow refs ("¶12 · 4:30"). Errors are errata slips. Exactly one yellow mark is ever live inside the text: the active citation or chapter.

STORY: The visitor understands that Stanza "typesets" an episode into an edition they can trust. They believe it because every takeaway, chapter and quiz answer points to a numbered paragraph they can open. Then they generate, read, check, revise and export.

FIRST VIEWPORT: A full-width yellow edition band. The wordmark "Stanza" is set large in heavy condensed Archivo, top left; the server status is set as a press line, top right. Below it, inside the band, a white page holds one intake: a single drop zone for audio or transcript files, a paste area beside it, a "Set the sample episode" action, and a colophon line of limits. The primary action "Make the edition" sits bottom right of the page. During processing the page becomes a galley proof: a stage list with rule fills, ETAs and marginal notices. Results open as a book spread: a sticky yellow contents rail on the left (player, chapters with leaders and times, export), and the reading column on the right.

FORM: Annotated study edition (line-numbered verse edition fused with the yellow pocket study classic), candidate 7 of 7, seed key 1f88f016. Raises: the quiz is one question per column, from the vertical feed; one bright state only, from the transit diagram; a binding baseline measure, from Crouwel; an index of cited lines into the text, from the star atlas. Signature interaction: clicking any citation scrolls to its numbered paragraph and sweeps a yellow highlighter across it. The audio element drives a live position marker down the contents, kept from the J-card.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
