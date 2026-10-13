/**
 * Measure the fact-checker on hand-labelled cases (scripts/factcheck-cases.json):
 * 24 claims (supported / changed number / contradiction / overstatement / not mentioned)
 * and 6 quiz questions, all from the synthetic sample episode.
 *
 *   npm run eval:factcheck -w server
 *
 * Cost: claims and questions are batched, so a run is ~3 judge calls (~8K tokens) on the
 * router model (Groq gpt-oss-20b by default). Prints a Markdown table for the README.
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createProviders } from '../src/llm/providers.js';
import { createProgress } from '../src/lib/progress.js';
import { judgeClaims, factCheckQuestions } from '../src/pipeline/factcheck.js';

const config = loadConfig();
const providers = createProviders(config);
const cases = JSON.parse(fs.readFileSync(new URL('./factcheck-cases.json', import.meta.url), 'utf8'));

// One pseudo-segment per evidence block, so citations work exactly as in the app.
const evidenceIds = Object.keys(cases.evidence);
const segments = evidenceIds.map((key, i) => ({ id: `S${String(i * 10 + 1).padStart(4, '0')}`, text: cases.evidence[key], start: null, end: null }));
const segFor = Object.fromEntries(evidenceIds.map((key, i) => [key, segments[i].id]));
// Pad with filler so ±1 neighbours never pull another evidence block into a claim's context.
const padded = segments.flatMap((s, i) => [s, { id: `S${String(i * 10 + 2).padStart(4, '0')}`, text: '(music)', start: null, end: null }]);

const deps = { config, providers };
const progress = createProgress();
const t0 = Date.now();

const items = cases.claims.map((c) => ({ id: `TK${c.id}`, section: 'takeaways', text: c.text, segmentIds: [segFor[c.e]] }));
const { verdicts, checker } = await judgeClaims({ items, segments: padded, deps, progress });

const rows = cases.claims.map((c) => {
  const v = verdicts.get(`TK${c.id}`);
  const pass = v?.verdict === 'supported';
  return { ...c, verdict: v?.verdict ?? 'no result', correct: v ? pass === c.label : null, reason: v?.reason ?? '' };
});

const letters = (q) => Object.keys(q.options);
const questions = cases.quiz.map((q) => ({
  id: q.id,
  question: q.question,
  options: letters(q).map((k) => q.options[k]),
  answerIndex: letters(q).indexOf(q.answer),
  segmentIds: [segFor[q.e]],
}));
const quiz = await factCheckQuestions({ questions, segments: padded, deps, progress });
const seconds = ((Date.now() - t0) / 1000).toFixed(1);

const byKind = {};
for (const r of rows) {
  byKind[r.kind] ??= { n: 0, ok: 0 };
  byKind[r.kind].n++;
  if (r.correct) byKind[r.kind].ok++;
}
const falseClaims = rows.filter((r) => !r.label);
const trueClaims = rows.filter((r) => r.label);

console.log(`\nChecker: ${checker ?? 'unavailable'} · ${seconds} s total\n`);
console.log(`Claims correct: ${rows.filter((r) => r.correct).length}/${rows.length}`);
console.log(`False claims caught: ${falseClaims.filter((r) => r.correct).length}/${falseClaims.length}`);
console.log(`True claims wrongly flagged: ${trueClaims.filter((r) => r.correct === false).length}/${trueClaims.length}`);
console.log(`Quiz answers confirmed: ${quiz.kept.filter((q) => q.check === 'confirmed').length}/${questions.length}\n`);
console.log('| Kind | Correct |\n|---|---|');
for (const [k, v] of Object.entries(byKind)) console.log(`| ${k} | ${v.ok}/${v.n} |`);
console.log('\n| # | Kind | Expected | Verdict | Reason |\n|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.id} | ${r.kind} | ${r.label ? 'supported' : 'not supported'} | ${r.correct ? '✅' : '❌'} ${r.verdict} | ${r.reason.replace(/\|/g, '/')} |`);
if (quiz.dropped.length) console.log(`\nQuiz questions dropped:\n${quiz.dropped.map((d) => `- ${d.question}: ${d.reason}`).join('\n')}`);
