/**
 * Run the revision router against scripts/router-cases.json using the real router model and
 * print a Markdown table for the README.
 *   npm run eval:router -w server
 */
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createProviders } from '../src/llm/providers.js';
import { generateStructured } from '../src/llm/structured.js';
import { LLM_Route } from '../src/schemas/index.js';
import { ROUTER_SYSTEM, buildOutline, routerPrompt } from '../src/prompts/revise.js';
import { validateRoute } from '../src/pipeline/revise.js';

const config = loadConfig();
const providers = createProviders(config);
const cases = JSON.parse(fs.readFileSync(new URL('./router-cases.json', import.meta.url), 'utf8'));

// A realistic outline: 5 chapters, 6 questions.
const result = {
  overview: {
    summary: 'The host and a sleep researcher discuss how caffeine, light exposure and exercise affect sleep quality, and give practical routines.',
    themes: ['sleep', 'caffeine', 'routines'],
    takeaways: [{ text: 't', segmentIds: ['S0001'] }],
    chapters: ['Why sleep matters', 'Caffeine timing', 'Light and the body clock', 'Exercise and rest', 'Building a routine'].map((title, i) => ({ id: `C${i + 1}`, title })),
  },
  quiz: { questions: Array.from({ length: 6 }, (_, i) => ({ id: `Q${i + 1}`, difficulty: 'easy', question: `Question ${i + 1} about sleep?` })), dropped: [] },
  hasTimestamps: true,
};

const rows = [];
let pass = 0;
for (const c of cases) {
  let got;
  try {
    const { data, provider } = await generateStructured({
      task: 'route',
      system: ROUTER_SYSTEM,
      user: routerPrompt({ request: c.request, outline: buildOutline(result) }),
      schema: LLM_Route,
      providers: [providers.router, providers.primary],
      timeoutMs: config.llmTimeoutMs,
    });
    got = { ...validateRoute(data, result, c.request), provider };
  } catch (err) {
    got = { action: `error: ${err.code}` };
  }
  const sections = got.targets?.map((t) => t.section) ?? [];
  const ids = got.targets?.flatMap((t) => t.ids) ?? [];
  const ok =
    got.action === c.expect.action &&
    (!c.expect.sections || c.expect.sections.every((s) => sections.includes(s))) &&
    (!c.expect.ids || c.expect.ids.every((id) => ids.includes(id)));
  if (ok) pass++;
  const detail = got.action === 'revise' ? `${sections.join('+')}${ids.length ? ` ${ids.join(',')}` : ''}` : (got.clarifyQuestion ?? got.rejectReason ?? '');
  rows.push(`| ${ok ? '✅' : '❌'} | ${c.request} | ${c.expect.action} | ${got.action} | ${String(detail).replace(/\|/g, '/').slice(0, 90)} |`);
  console.error(`${ok ? 'PASS' : 'FAIL'} ${c.request}`);
}

console.log(`\nRouter accuracy: ${pass}/${cases.length}\n`);
console.log('| | Request | Expected | Got | Detail |\n|---|---|---|---|---|');
console.log(rows.join('\n'));
