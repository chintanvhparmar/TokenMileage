// Model research agent: for each model in the user's picker, Nemotron (taskModels.research) uses Tavily
// as tools to find what the vendor says it's best for, its API price, context window and release date,
// from the vendor's official sites only. Code then checks the answer against the text Tavily returned
// (the model name and every price must appear in it) and keeps the sources. Results are cached in
// chrome.storage.local and re-checked monthly. Only model names go to Tavily, never chat content.
import { loadConfig, getTokenFactoryConfig } from '../shared/config.js';
import { getSettings } from '../shared/settings.js';
import { researchSystem, buildResearchUser } from '../shared/prompts.js';
import { validateResearch } from '../shared/schemas.js';
import { nemotronChat, nemotronJson, parseJsonLoose, TokenFactoryError } from './tokenFactory.js';
import { getCatalogue, getResearch, saveResearch } from './models.js';
import * as tavily from './tavily.js';

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'tavily_search',
      description: "Web search limited to the vendor's official sites. Returns up to 5 results: title, url, snippet.",
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search query, e.g. "Claude Sonnet 5.5 pricing"' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'tavily_extract',
      description: 'Reads up to 3 pages (URLs from search results) and returns the parts most relevant to the query.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'array', items: { type: 'string' }, maxItems: 3 },
          query: { type: 'string', description: 'What to look for, e.g. "Sonnet 5.5 price per million tokens, best for"' },
        },
        required: ['urls', 'query'],
      },
    },
  },
];

// One model at a time: research runs in the background after new models are seen.
let queue = Promise.resolve();
const running = new Set();

export function researchPending(site, { force = false } = {}) {
  queue = queue.then(() => runPending(site, force)).catch(() => {});
  return queue;
}

async function runPending(site, force) {
  const [{ tavilyKey, apiKey }, tf] = await Promise.all([getSettings(), getTokenFactoryConfig()]);
  if (!tavilyKey || !apiKey) return;
  const research = await getResearch();
  for (const m of await getCatalogue(site)) {
    if (force || isDue(research[m.id], tf.research)) await researchModel({ site, id: m.id }).catch(() => {});
  }
}

function isDue(r, cfg) {
  if (!r) return true;
  if (r.status === 'running') return Date.now() - r.startedAt > 10 * 60e3; // a run the service worker lost
  const age = Date.now() - r.checkedAt;
  return r.status === 'done' ? age > cfg.recheckDays * 864e5 : age > cfg.retryHours * 36e5;
}

// Researches one model now (options page "Re-check", or from the queue). Returns the stored entry.
export async function researchModel({ site, id }) {
  const model = (await getCatalogue(site)).find((m) => m.id === id);
  if (!model) throw new Error('That model is not in the list for this site');
  if (running.has(id)) return null;
  running.add(id);
  const prev = (await getResearch())[id];
  await saveResearch(id, { ...prev, status: 'running', startedAt: Date.now() });
  let entry;
  try {
    const out = await runResearch({ site, model });
    entry = { status: 'done', checkedAt: Date.now(), name: model.label, ...out };
  } catch (e) {
    // Keep earlier good facts if a re-check fails.
    entry = prev?.status === 'done'
      ? { ...prev, lastError: e.message, lastErrorAt: Date.now() }
      : { status: 'failed', checkedAt: Date.now(), name: model.label, error: e.message };
  } finally {
    running.delete(id);
  }
  await saveResearch(id, entry);
  return entry;
}

/**
 * Researches one catalogue model without storing anything (shared with the bench comparison).
 * method: 'agent' (default) or 'pipeline'. modelId: a Nemotron id to use instead of taskModels.research.
 * Returns the grounded facts plus method, tool_calls (made by Nemotron), queries and stats
 * ({ nemotron_calls, prompt_tokens, completion_tokens, est_cost_usd, tavily_calls, tavily_credits, ms }).
 */
export async function runResearch({ site, model, method = 'agent', modelId, feature = 'research' }) {
  const [models, tf] = await Promise.all([loadConfig('models'), getTokenFactoryConfig()]);
  const { vendor, domains } = models.sites[site].research;
  const ctx = { model, vendor, domains, cfg: tf.research, modelId, feature, stats: {}, corpus: new Map(), queries: [] };
  const t0 = performance.now();
  const out = method === 'pipeline' ? await pipeline(ctx, 'chosen') : await runAgent(ctx);
  return { ...out, queries: ctx.queries, stats: { ...ctx.stats, ms: Math.round(performance.now() - t0) } };
}

// The first search is always the same ("<vendor> <model> pricing and best uses"), so code runs it and
// hands Nemotron the results as if it had asked for them; that saves one Nemotron call. From there
// Nemotron decides which pages to read and whether to search again.
const seedQuery = (vendor, name) => `${vendor} ${name} model pricing and what it is best for`;

// Agent loop. Falls back to the fixed pipeline if Token Factory rejects tools for this model.
async function runAgent(ctx) {
  const { model, vendor, domains, cfg, corpus, stats, modelId, feature } = ctx;
  const messages = [
    { role: 'system', content: researchSystem({ vendor, maxToolCalls: cfg.maxToolCalls, withTools: true }) },
    { role: 'user', content: buildResearchUser({ vendor, model: model.label, description: model.description }) },
  ];
  const seed = { id: 'seed', type: 'function', function: { name: 'tavily_search', arguments: JSON.stringify({ query: seedQuery(vendor, model.label) }) } };
  messages.push(
    { role: 'assistant', content: '', tool_calls: [seed] },
    { role: 'tool', tool_call_id: seed.id, content: await runTool(seed, ctx) },
  );
  let used = 1;      // Tavily calls so far, including the seed search
  let ownCalls = 0;  // tool calls Nemotron made itself (what the bench measures)
  let retried = false;
  for (let step = 0; step < cfg.maxSteps; step++) {
    const budgetLeft = used < cfg.maxToolCalls;
    let msg;
    try {
      msg = await nemotronChat({ feature, messages, tools: TOOLS, toolChoice: budgetLeft ? 'auto' : 'none', maxTokens: 900, modelId, stats });
    } catch (e) {
      if (step === 0 && e.code === 'http') return pipeline(ctx, `tools rejected: ${e.message.slice(0, 120)}`);
      throw e;
    }
    const calls = budgetLeft ? msg.tool_calls ?? [] : [];
    if (calls.length) {
      messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: calls });
      for (const c of calls) {
        used++;
        ownCalls++;
        const content = used <= cfg.maxToolCalls ? await runTool(c, ctx) : 'Tool budget used up. Reply with the JSON object now.';
        messages.push({ role: 'tool', tool_call_id: c.id, content });
      }
      if (used >= cfg.maxToolCalls) messages.push({ role: 'user', content: 'No more tool calls. Reply with ONLY the JSON object now.' });
      continue;
    }
    // An answer without further tool calls is allowed: the seed search may already hold the facts.
    const parsed = parseJsonLoose(msg.content ?? '');
    const v = parsed.ok ? validateResearch(parsed.value) : parsed;
    if (v.ok) return { ...ground(v.value, corpus, model.label), method: 'agent', tool_calls: ownCalls };
    if (retried) break;
    retried = true;
    messages.push(
      { role: 'assistant', content: msg.content ?? '' },
      { role: 'user', content: `Invalid reply: ${v.error}. Reply with ONLY the JSON object, matching the schema exactly.` },
    );
  }
  throw new TokenFactoryError('The research agent did not return valid facts', 'invalid_json');
}

const inDomains = (url, domains) => {
  try {
    const host = new URL(url).hostname;
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
};

async function runTool(call, { domains, corpus, cfg, queries, stats }) {
  let args;
  try {
    args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function?.arguments ?? {};
  } catch {
    return 'Error: arguments were not valid JSON.';
  }
  try {
    if (call.function?.name === 'tavily_search') {
      const query = String(args.query ?? '').slice(0, 200).trim();
      if (!query) return 'Error: query is empty.';
      queries.push(query);
      const results = await tavily.search(query, domains, 5, stats);
      for (const r of results) corpus.set(r.url, `${corpus.get(r.url) ?? ''}\n${r.title}\n${r.content}`);
      return JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 600) })));
    }
    if (call.function?.name === 'tavily_extract') {
      const urls = (Array.isArray(args.urls) ? args.urls : []).filter((u) => inDomains(u, domains)).slice(0, 3);
      if (!urls.length) return `Error: give 1-3 URLs on ${domains.join(', ')}.`;
      const { pages, failed } = await tavily.extract(urls, String(args.query ?? '').slice(0, 200), stats);
      for (const p of pages) corpus.set(p.url, `${corpus.get(p.url) ?? ''}\n${p.text}`);
      return JSON.stringify({
        pages: pages.map((p) => ({ url: p.url, text: p.text.slice(0, cfg.pageChars) })),
        failed,
      });
    }
    return `Error: unknown tool ${call.function?.name}.`;
  } catch (e) {
    if (e.code === 'no_key' || e.code === 'auth') throw e;
    return `Error: ${e.message}`;
  }
}

// Fallback: one search and one extract chosen by code; Nemotron only reads and fills in the JSON.
async function pipeline(ctx, reason) {
  const { model, vendor, domains, cfg, corpus, stats, queries, modelId, feature } = ctx;
  const query = seedQuery(vendor, model.label);
  queries.push(query);
  const results = await tavily.search(query, domains, 5, stats);
  for (const r of results) corpus.set(r.url, `${corpus.get(r.url) ?? ''}\n${r.title}\n${r.content}`);
  const { pages } = results.length
    ? await tavily.extract(results.slice(0, 3).map((r) => r.url), `${model.label} price per million tokens, best for, context window`, stats)
    : { pages: [] };
  for (const p of pages) corpus.set(p.url, `${corpus.get(p.url) ?? ''}\n${p.text}`);
  const user = `${buildResearchUser({ vendor, model: model.label, description: model.description })}

Search results:
${JSON.stringify(results.map((r) => ({ title: r.title, url: r.url, snippet: (r.content ?? '').slice(0, 600) })))}

Pages:
${pages.map((p) => `<<<PAGE ${p.url}\n${p.text.slice(0, cfg.pageChars)}\nPAGE>>>`).join('\n')}`;
  const facts = await nemotronJson({
    feature,
    system: researchSystem({ vendor, withTools: false }),
    user,
    validate: validateResearch,
    maxTokens: 600,
    modelId,
    stats,
  });
  return { ...ground(facts, corpus, model.label), method: 'pipeline', fallback_reason: reason, tool_calls: 0 };
}

// Keep only what the fetched text supports: the model's name must appear in it (else the facts are
// probably about another model), each price must appear as "$<n>", and sources must be fetched URLs.
export function ground(facts, corpus, name) {
  const text = [...corpus.values()].join('\n');
  const checks = {};
  const out = { ...facts };
  // Sources: fetched pages that mention this model (a page about another model isn't a source for it).
  const mentions = (u) => nameRegex(name).test(corpus.get(u) ?? '');
  out.sources = facts.sources.filter((u) => corpus.has(u) && mentions(u));
  if (!out.sources.length) out.sources = [...corpus.keys()].filter(mentions).slice(0, 2);
  if (!nameRegex(name).test(text)) {
    checks.model_named = false;
    return { ...out, best_for: [], api_price_per_mtok: null, size_class: null, context_window_tokens: null, checks };
  }
  // A pricing page lists every model: the prices must appear just after this model's name (same table
  // row or sentence), not just anywhere on the page.
  const p = facts.api_price_per_mtok;
  if (p) {
    const near = [...text.matchAll(new RegExp(nameRegex(name).source, 'gi'))].map((m) => text.slice(m.index, m.index + 250));
    checks.price_in_text = near.some((w) => priceInText(p.input, w) && priceInText(p.output, w));
    if (!checks.price_in_text) out.api_price_per_mtok = null;
  }
  return { ...out, checks };
}

// "Sonnet 5.5" also matches "sonnet-5-5" (API ids), but "Sonnet 5" doesn't match "Sonnet 5.5".
function nameRegex(name) {
  return new RegExp(`\\b${name.split(/[\s.-]+/).map(escape).join('[\\s.-]?')}(?![.-]?\\d)`, 'i');
}

function priceInText(n, text) {
  const forms = new Set([String(n), n.toFixed(2), n.toFixed(1)]);
  return [...forms].some((f) => new RegExp(`\\$\\s?${escape(f)}(?!\\d)`).test(text));
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
