// Nemotron benchmark page: (1) API probe, (2) Evaluate quality across models / reasoning / prompt variants.
// Scores raw model output; results download as JSON for the README and NEBIUS_FEEDBACK.md.
import { loadConfig, getTokenFactoryConfig, resolveModel } from '../src/shared/config.js';
import { validateEvaluate, EVALUATE_ENUMS } from '../src/shared/schemas.js';
import { TIP_CODES } from '../src/shared/tips.js';
import { rawChat } from '../src/background/tokenFactory.js';
import { buildEvaluateRequest, cleanRevision } from '../src/background/evaluate.js';
import { getCatalogue } from '../src/background/models.js';
import { runResearch } from '../src/background/research.js';
import { CASES } from './cases.js';

const $ = (id) => document.getElementById(id);
const CONCURRENCY = 3;
const PLAN = { type: 'spend', unused_allowance_lost: true }; // fixed so runs are comparable

const REASONING = {
  off: { overrides: {}, maxTokens: 600 }, // config default: enable_thinking:false
  on: {
    overrides: { reasoningOff: { systemPrefix: '', extraBody: { chat_template_kwargs: { enable_thinking: true } } }, timeoutMs: 120000 },
    maxTokens: 4000,
  },
};

const results = { started: null, env: null, probe: [], quality: [], summary: [], research: [], researchSummary: [] };

// ---------- helpers ----------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) el.setAttribute(k, v);
  for (const c of children.flat()) if (c != null) el.append(c);
  return el;
}

async function pool(tasks, n, onDone) {
  let i = 0;
  const worker = async () => { while (i < tasks.length) { const t = tasks[i++]; onDone(await t()); } };
  await Promise.all(Array.from({ length: n }, worker));
}

async function timed(overrides, args) {
  try {
    return { ok: true, ...(await rawChat(overrides, args)) };
  } catch (e) {
    return { ok: false, error: e.message, code: e.code };
  }
}

function table(headers, rows) {
  return h('table', {},
    h('tr', {}, headers.map((x) => h('th', {}, x))),
    rows.map((r) => h('tr', {}, r.map((c) => {
      if (c instanceof Node) return h('td', {}, c);
      if (c && typeof c === 'object' && 'v' in c) return h('td', { class: c.cls ?? '' }, String(c.v));
      return h('td', {}, c == null ? '' : String(c));
    }))));
}
const flag = (b) => (b == null ? { v: '–' } : { v: b ? '✓' : '✗', cls: b ? 'ok' : 'bad' });
const pct = (n, d) => (d ? { v: `${Math.round((100 * n) / d)}%`, cls: n === d ? 'ok' : n === 0 ? 'bad' : '' } : { v: '–' });
const avg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };

function selectedModels() {
  return [...document.querySelectorAll('input[name=model]:checked')].map((i) => i.value);
}
function checked(name) {
  return [...document.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
}
function setStatus(t) { $('status').textContent = t; }

// One run at a time: a second click while a run is going would mix two runs' rows (seen 2026-10-27).
const RUN_BUTTONS = ['runProbe', 'runQuality', 'runResearch'];
let busy = false;
function runOnce(fn) {
  return async () => {
    if (busy) return;
    busy = true;
    RUN_BUTTONS.forEach((id) => { $(id).disabled = true; });
    try {
      await fn();
    } finally {
      busy = false;
      RUN_BUTTONS.forEach((id) => { $(id).disabled = false; });
    }
  };
}

// ---------- setup ----------
const [tf, modelsCfg] = await Promise.all([getTokenFactoryConfig(), loadConfig('models')]);
const catalogue = modelsCfg.sites.claude.models;
const rules = modelsCfg.rules;
const nemotron = Object.values(tf.models).map((m) => m.id).filter(Boolean); // config order: smallest first
$('models').append(...nemotron.map((id) => h('label', {}, h('input', { type: 'checkbox', name: 'model', value: id, checked: '' }), ` ${id}`)));
results.env = { baseUrl: tf.baseUrl, stream: tf.stream, jsonMode: tf.jsonMode, reasoningOff: tf.reasoningOff, userAgent: navigator.userAgent };

// ---------- 1. API probe ----------
const PROBE_SYSTEM = 'Classify the sentiment of the user text. Reply with only JSON: {"sentiment": "positive" | "negative" | "neutral"}';
const PROBE_USER = 'The new release fixed my bug, thanks!';
const SENTIMENT_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'sentiment',
    strict: true,
    schema: { type: 'object', properties: { sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] } }, required: ['sentiment'], additionalProperties: false },
  },
};
const PROBES = [
  ['stream · extension default (config reasoningOff)', {}],
  ['NON-stream · extension default', { stream: false, timeoutMs: 45000 }],
  ['stream · no reasoning switch', { reasoningOff: { systemPrefix: '', extraBody: {} } }],
  ['stream · enable_thinking:false only', { reasoningOff: { systemPrefix: '', extraBody: { chat_template_kwargs: { enable_thinking: false } } } }],
  ['stream · /no_think only', { reasoningOff: { systemPrefix: '/no_think', extraBody: {} } }],
  ['stream · enable_thinking:true', { reasoningOff: { systemPrefix: '', extraBody: { chat_template_kwargs: { enable_thinking: true } } } }],
  ['stream · response_format json_schema (strict)', { responseFormat: SENTIMENT_SCHEMA }],
];
const ALT_BASE = 'https://api.tokenfactory.nebius.com/v1';

$('runProbe').addEventListener('click', runOnce(async () => {
  const models = selectedModels();
  const tasks = [];
  for (const model of models) {
    for (const [name, ov] of PROBES) {
      tasks.push(async () => ({ model, probe: name, ...(await timed({ timeoutMs: 60000, ...ov }, { model, system: PROBE_SYSTEM, user: PROBE_USER, maxTokens: 1500 })) }));
    }
  }
  if (models.includes(tf.models.lightning.id)) {
    tasks.push(async () => ({ model: tf.models.lightning.id, probe: `stream · alt base URL ${ALT_BASE}`, ...(await timed({ baseUrl: ALT_BASE, timeoutMs: 60000 }, { model: tf.models.lightning.id, system: PROBE_SYSTEM, user: PROBE_USER, maxTokens: 1500 })) }));
  }
  results.started ??= new Date().toISOString();
  results.probe = [];
  let done = 0;
  setStatus(`Probe: 0/${tasks.length}…`);
  await pool(tasks, CONCURRENCY, (r) => {
    const valid = r.ok && r.parsed?.ok && ['positive', 'negative', 'neutral'].includes(r.parsed.value?.sentiment);
    results.probe.push({
      model: r.model, probe: r.probe, ok: r.ok, error: r.error ?? null, ms: r.ms ?? null, ttftMs: r.ttftMs ?? null,
      completionTokens: r.usage?.completion_tokens ?? null, promptTokens: r.usage?.prompt_tokens ?? null,
      reasoningChars: r.reasoningChars ?? null, validJson: !!valid, content: r.content?.slice(0, 300) ?? null,
    });
    setStatus(`Probe: ${++done}/${tasks.length}…`);
  });
  renderAll();
  setStatus(`Probe done (${tasks.length} calls).`);
}));

// ---------- 2. Evaluate quality ----------
const SAVING = EVALUATE_ENUMS.saving;
function expectedSaving(ratio) {
  const t = rules.savingByUsageRatio;
  return ratio >= t.high ? 'high' : ratio >= t.medium ? 'medium' : ratio >= t.low ? 'low' : 'none';
}
const FORMAT_TIP = /\btable\b|bullet|copy[- ]?paste|spreadsheet|markdown|column/i;
// Thread advice (new chat, history, context) only makes sense when the card says start a fresh chat.
// Artifact tips ("artifact avoids re-reading the guide in chat") are about output, not the thread.
const THREAD_TIP = /^(?!.*artifact).*(new chat|fresh chat|\bhistory\b|re-?read|\bthread\b|\bcontext\b|chat (short|length|long))/i;

function score(c, variant, r, req) {
  const checks = {};
  if (!r.ok) return { checks: { json: false }, error: r.error };
  const v = r.parsed.ok ? validateEvaluate(r.parsed.value, catalogue.map((m) => m.id)) : r.parsed;
  checks.json = v.ok;
  if (!v.ok) return { checks, error: v.error };

  const out = v.value;
  const rawTips = r.parsed.value.tips;
  const rec = catalogue.find((m) => m.id === out.recommend.model);
  const cur = resolveModel(catalogue, c.modelLabel);

  checks.complexity = c.expect.complexity.includes(out.complexity);
  if ('tools' in c.expect) checks.tools = out.recommend.tools_needed === c.expect.tools;
  if ('fresh' in c.expect) checks.fresh = out.recommend.fresh_chat === c.expect.fresh;

  if (variant === 'free') {
    checks.consistent =
      rec.tier === rules.tierByComplexity[out.complexity] && out.recommend.effort === rules.effortByComplexity[out.complexity];
    if (cur) {
      const want = expectedSaving(cur.relative_price / rec.relative_price);
      checks.saving = Math.abs(SAVING.indexOf(out.est_relative_usage_saving) - SAVING.indexOf(want)) <= 1;
    }
    const tips = rawTips.map(String);
    const others = catalogue.filter((m) => m.id !== rec.id).flatMap((m) => [m.label.toLowerCase(), ...(m.aliases ?? [])]);
    const suggestsOther = (t) => others.some((a) => new RegExp(`\\b(use|switch(ing)? to|try|choose|pick|go with|move to)\\b[^.]{0,20}\\b${a}`, 'i').test(t));
    checks.tipsMax3 = tips.length <= 3;
    checks.noAnswerLeak = !c.expect.answerLeak || !tips.some((t) => c.expect.answerLeak.test(t));
    checks.noContradiction = !tips.some(suggestsOther);
    checks.noFormatTip = c.expect.allowFormat || !tips.some((t) => FORMAT_TIP.test(t));
    checks.tipsMatchThread = out.recommend.fresh_chat || !tips.some((t) => THREAD_TIP.test(t));

    // Revised prompt, after the same clean-up as the extension (dropped when truncated or unchanged).
    out.revised_prompt = cleanRevision(out.revised_prompt, req);
    const rev = out.revised_prompt;
    if ('revise' in c.expect) checks.revised = !!rev === c.expect.revise;
    if (rev) {
      checks.revisedNoAnswer = !c.expect.answerLeak || !c.expect.answerLeak.test(rev);
      // Pasted data and code must survive the rewrite exactly.
      if (c.expect.keep) checks.revisedKeeps = c.expect.keep.every((k) => rev.includes(k));
      // Details the user left open: the rewrite may name none of the options or all of them, never a pick.
      if (c.expect.openChoice) {
        const named = c.expect.openChoice.filter((re) => re.test(rev)).length;
        checks.revisedNoGuess = named === 0 || named === c.expect.openChoice.length;
      }
      // Scope changes and content the rewrite must not add.
      if (c.expect.noAdd) checks.revisedNoAdd = !c.expect.noAdd.test(rev);
    }
  } else {
    checks.codesOnly = rawTips.length <= 2 && rawTips.every((t) => TIP_CODES.includes(t));
  }
  return { checks, out };
}

$('runQuality').addEventListener('click', runOnce(async () => {
  const models = selectedModels();
  const reasonings = checked('reasoning');
  const variants = checked('variant');
  const tasks = [];
  for (const model of models) for (const reasoning of reasonings) for (const variant of variants) for (const c of CASES) {
    tasks.push(async () => {
      const req = buildEvaluateRequest({
        mode: variant, site: 'claude', prompt: c.draft, modelLabel: c.modelLabel, thread: c.thread, usage: null,
        plan: PLAN, catalogue, maxPromptChars: tf.maxPromptChars,
      });
      const { overrides, maxTokens } = REASONING[reasoning];
      // Same output room as the extension (req.maxTokens), plus the reasoning budget when reasoning is on.
      const r = await timed(overrides, { model, system: req.system, user: req.user, maxTokens: reasoning === 'on' ? maxTokens + req.maxTokens : req.maxTokens });
      const s = score(c, variant, r, req);
      return {
        model, reasoning, variant, case: c.id, ok: r.ok, error: s.error ?? null, checks: s.checks,
        pass: Object.values(s.checks).every(Boolean),
        ms: r.ms ?? null, ttftMs: r.ttftMs ?? null, completionTokens: r.usage?.completion_tokens ?? null,
        promptTokens: r.usage?.prompt_tokens ?? null, reasoningChars: r.reasoningChars ?? null,
        output: s.out ?? null, raw: s.out ? null : r.content?.slice(0, 1500) ?? null,
      };
    });
  }
  results.started ??= new Date().toISOString();
  results.quality = [];
  let done = 0;
  setStatus(`Quality: 0/${tasks.length}…`);
  await pool(tasks, CONCURRENCY, (row) => { results.quality.push(row); setStatus(`Quality: ${++done}/${tasks.length}…`); });
  renderAll();
  setStatus(`Quality done (${tasks.length} calls).`);
}));

// ---------- 3. Model research ----------
const siteCatalogue = await getCatalogue('claude');
$('siteModels').replaceChildren(...siteCatalogue.map((m) =>
  h('label', {}, h('input', { type: 'checkbox', name: 'siteModel', value: m.id, checked: '' }), ` ${m.label}`)));

$('runResearch').addEventListener('click', runOnce(async () => {
  const models = selectedModels();
  const methods = checked('method');
  const picked = siteCatalogue.filter((m) => checked('siteModel').includes(m.id));
  const tasks = [];
  for (const nemotronId of models) for (const method of methods) for (const m of picked) {
    tasks.push(async () => {
      const row = { nemotron: nemotronId, requested: method, model: m.label }; // r.method: what actually ran
      try {
        const r = await runResearch({ site: 'claude', model: m, method, modelId: nemotronId, feature: 'bench' });
        return { ...row, ok: true, ...r };
      } catch (e) {
        return { ...row, ok: false, error: e.message };
      }
    });
  }
  results.started ??= new Date().toISOString();
  results.research = [];
  let done = 0;
  setStatus(`Research: 0/${tasks.length}…`);
  await pool(tasks, 2, (row) => { results.research.push(row); setStatus(`Research: ${++done}/${tasks.length}…`); });
  renderAll();
  setStatus(`Research done (${tasks.length} runs).`);
}));

// Per row: what was found and survived the checks. "agrees" compares the price with the most common
// price found for that model across all rows (a cross-check: there's no answer key for new models).
function researchScore(rows) {
  const key = (p) => (p ? `${p.input}/${p.output}` : null);
  const majority = new Map();
  for (const name of new Set(rows.map((r) => r.model))) {
    const counts = new Map();
    for (const r of rows.filter((x) => x.model === name && key(x.api_price_per_mtok))) {
      const k = key(r.api_price_per_mtok);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    majority.set(name, [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null);
  }
  return rows.map((r) => ({
    ...r,
    bestFor: r.ok && r.best_for?.length > 0,
    price: r.ok && !!r.api_price_per_mtok,
    size: r.ok && !!r.size_class,
    dropped: r.ok && (r.checks?.price_in_text === false || r.checks?.model_named === false),
    agrees: r.ok && r.api_price_per_mtok ? key(r.api_price_per_mtok) === majority.get(r.model) : null,
  }));
}

function summariseResearch(scored) {
  const groups = new Map();
  for (const r of scored) {
    const k = `${r.nemotron}|${r.requested}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const sum = (rows, f) => rows.reduce((a, r) => a + (f(r) ?? 0), 0);
  return [...groups.entries()].map(([k, rows]) => {
    const [nemotron, method] = k.split('|');
    const ok = rows.filter((r) => r.ok);
    return {
      nemotron, method, runs: rows.length, errors: rows.length - ok.length,
      fellBack: ok.filter((r) => r.method === 'pipeline' && method === 'agent').length,
      bestFor: ok.filter((r) => r.bestFor).length, price: ok.filter((r) => r.price).length, size: ok.filter((r) => r.size).length,
      dropped: ok.filter((r) => r.dropped).length,
      agrees: ok.filter((r) => r.agrees).length, priced: ok.filter((r) => r.agrees != null).length,
      avgOwnToolCalls: ok.length ? Math.round((10 * sum(ok, (r) => r.tool_calls)) / ok.length) / 10 : null,
      tavilyCredits: sum(ok, (r) => r.stats?.tavily_credits),
      costUsd: sum(ok, (r) => r.stats?.est_cost_usd),
      avgMs: avg(ok.map((r) => r.stats?.ms)),
      tokens: sum(ok, (r) => (r.stats?.prompt_tokens ?? 0) + (r.stats?.completion_tokens ?? 0)),
    };
  });
}

// ---------- rendering ----------
const CHECKS = ['json', 'complexity', 'tools', 'fresh', 'consistent', 'saving', 'tipsMax3', 'noAnswerLeak', 'noContradiction', 'noFormatTip', 'tipsMatchThread', 'revised', 'revisedNoAnswer', 'revisedKeeps', 'revisedNoGuess', 'revisedNoAdd', 'codesOnly'];

function summarise() {
  const groups = new Map();
  for (const r of results.quality) {
    const k = `${r.model}|${r.reasoning}|${r.variant}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([k, rows]) => {
    const [model, reasoning, variant] = k.split('|');
    const byCheck = Object.fromEntries(CHECKS.map((ch) => {
      const applicable = rows.filter((r) => r.checks[ch] !== undefined);
      return [ch, { pass: applicable.filter((r) => r.checks[ch]).length, of: applicable.length }];
    }));
    return {
      model, reasoning, variant, cases: rows.length, allPass: rows.filter((r) => r.pass).length, errors: rows.filter((r) => !r.ok).length,
      byCheck, avgMs: avg(rows.map((r) => r.ms)), avgTtftMs: avg(rows.map((r) => r.ttftMs)),
      avgCompletionTokens: avg(rows.map((r) => r.completionTokens)), avgReasoningChars: avg(rows.map((r) => r.reasoningChars)),
    };
  });
}

function renderAll() {
  const out = $('out');
  out.replaceChildren();
  if (results.probe.length) {
    out.append(h('h2', {}, 'API probe results'), table(
      ['model', 'probe', 'ok', 'valid JSON', 'total ms', 'TTFT ms', 'out tokens', 'reasoning chars', 'error / reply'],
      [...results.probe].sort((a, b) => (a.model + a.probe).localeCompare(b.model + b.probe)).map((p) => [
        p.model, p.probe, flag(p.ok), flag(p.ok ? p.validJson : null), { v: p.ms ?? '', cls: 'num' }, { v: p.ttftMs ?? '', cls: 'num' },
        { v: p.completionTokens ?? '', cls: 'num' }, { v: p.reasoningChars ?? '', cls: 'num' }, h('pre', {}, p.error ?? p.content ?? ''),
      ]),
    ));
  }
  if (results.quality.length) {
    results.summary = summarise();
    out.append(h('h2', {}, 'Evaluate quality: summary'), table(
      ['model', 'reasoning', 'variant', 'all checks pass', ...CHECKS, 'errors', 'avg ms', 'avg TTFT', 'avg out tok', 'avg reasoning chars'],
      results.summary.map((s) => [
        s.model, s.reasoning, s.variant, pct(s.allPass, s.cases), ...CHECKS.map((ch) => pct(s.byCheck[ch].pass, s.byCheck[ch].of)),
        { v: s.errors, cls: s.errors ? 'bad' : '' }, { v: s.avgMs ?? '', cls: 'num' }, { v: s.avgTtftMs ?? '', cls: 'num' },
        { v: s.avgCompletionTokens ?? '', cls: 'num' }, { v: s.avgReasoningChars ?? '', cls: 'num' },
      ]),
    ));
    out.append(h('h2', {}, 'Evaluate quality: per case'), table(
      ['case', 'model', 'reasoning', 'variant', ...CHECKS, 'ms', 'output (complexity · model · effort · saving · flags · tips · revised prompt) / error'],
      [...results.quality].sort((a, b) => (a.case + a.model + a.reasoning + a.variant).localeCompare(b.case + b.model + b.reasoning + b.variant)).map((r) => [
        r.case, r.model, r.reasoning, r.variant, ...CHECKS.map((ch) => flag(r.checks[ch])), { v: r.ms ?? '', cls: 'num' },
        h('pre', {}, r.output
          ? `${r.output.complexity} · ${r.output.recommend.model} · ${r.output.recommend.effort} · saving ${r.output.est_relative_usage_saving}` +
            ` · tools ${r.output.recommend.tools_needed} · fresh ${r.output.recommend.fresh_chat}\n- ${r.output.tips.join('\n- ')}` +
            (r.output.revised_prompt ? `\n\nREVISED:\n${r.output.revised_prompt}` : '')
          :`${r.error ?? ''}\n${r.raw ?? ''}`),
      ]),
    ));
  }
  if (results.research.length) {
    const scored = researchScore(results.research);
    results.researchSummary = summariseResearch(scored);
    out.append(h('h2', {}, 'Model research: summary'), table(
      ['nemotron', 'method', 'runs', 'errors', 'fell back to pipeline', 'best for found', 'price found', 'size found', 'dropped by checks', 'price agrees with majority', 'avg own tool calls', 'Tavily credits', 'tokens', 'est. cost $', 'avg ms'],
      results.researchSummary.map((s) => [
        s.nemotron, s.method, s.runs, { v: s.errors, cls: s.errors ? 'bad' : '' }, s.method === 'agent' ? { v: s.fellBack, cls: s.fellBack ? 'bad' : 'ok' } : '–',
        pct(s.bestFor, s.runs - s.errors), pct(s.price, s.runs - s.errors), pct(s.size, s.runs - s.errors),
        { v: s.dropped, cls: s.dropped ? 'bad' : '' }, pct(s.agrees, s.priced), { v: s.avgOwnToolCalls ?? '', cls: 'num' },
        { v: s.tavilyCredits, cls: 'num' }, { v: s.tokens, cls: 'num' }, { v: s.costUsd.toFixed(4), cls: 'num' }, { v: s.avgMs ?? '', cls: 'num' },
      ]),
    ));
    out.append(h('h2', {}, 'Model research: per run'), table(
      ['model', 'nemotron', 'method', 'ok', 'best for', 'price $/M in/out', 'size', 'checks', 'agrees', 'own tool calls', 'queries', 'sources', 'credits', 'ms', 'error'],
      [...scored].sort((a, b) => (a.model + a.nemotron + a.requested).localeCompare(b.model + b.nemotron + b.requested)).map((r) => [
        r.model, r.nemotron, r.requested + (r.requested === 'agent' && r.method === 'pipeline' ? ` (fell back: ${r.fallback_reason})` : ''), flag(r.ok),
        h('pre', {}, (r.best_for ?? []).join(', ')),
        r.api_price_per_mtok ? `${r.api_price_per_mtok.input} / ${r.api_price_per_mtok.output}` : '–',
        r.size_class ?? '–', h('pre', {}, r.checks ? JSON.stringify(r.checks) : ''), flag(r.agrees),
        { v: r.tool_calls ?? '', cls: 'num' }, h('pre', {}, (r.queries ?? []).join('\n')), h('pre', {}, (r.sources ?? []).join('\n')),
        { v: r.stats?.tavily_credits ?? '', cls: 'num' }, { v: r.stats?.ms ?? '', cls: 'num' }, h('pre', {}, r.error ?? ''),
      ]),
    ));
  }
  $('download').disabled = false;
}

$('download').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ ...results, cases: CASES.map(({ id, note, modelLabel, thread, expect }) => ({ id, note, modelLabel, thread, expect: JSON.parse(JSON.stringify(expect, (k, v) => (v instanceof RegExp ? v.source : v))) })) }, null, 2)], { type: 'application/json' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `tokenmileage-bench-${new Date().toISOString().replace(/[:.]/g, '-')}.json` });
  a.click();
});
