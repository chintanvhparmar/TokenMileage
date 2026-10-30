// "Mileage": what TokenMileage changed, for the outcome summary on the options page.
// Ids, efforts, flags and numbers only - never prompt text, chat titles or reply content.
import { getCatalogue } from './models.js';
import { loadConfig } from '../shared/config.js';

const KEY = 'outcomes';
const MAX_ENTRIES = 3000;
const EFFORTS = ['low', 'medium', 'high', 'max'];

async function append(entry) {
  const { [KEY]: log = [] } = await chrome.storage.local.get(KEY);
  log.push({ ts: Date.now(), ...entry });
  await chrome.storage.local.set({ [KEY]: log.slice(-MAX_ENTRIES) });
}

// After each Evaluate. fits: the user was already on the recommended model and effort.
export async function logEvaluate({ site, currentModel, recommendedModel, currentEffort, effort }) {
  const fits = !!currentModel && currentModel.id === recommendedModel.id && (!currentEffort || currentEffort === effort);
  await append({ kind: 'evaluate', site, from: currentModel?.id ?? null, to: recommendedModel.id, fits });
}

// After a confirmed "Apply" / "Apply & send" (sent = also sent). Prices are taken now, so the
// summary doesn't change if research later updates them.
export async function logApply({ site, from, to, fromEffort, toEffort, rewrite, newChat, sent, threadTokens }) {
  const catalogue = await getCatalogue(site);
  const price = (id) => catalogue.find((m) => m.id === id);
  const f = price(from);
  const t = price(to);
  await append({
    kind: 'apply', site, from: from ?? null, to: to ?? null,
    fromEffort: fromEffort ?? null, toEffort: toEffort ?? null,
    fromPrice: f?.relative_price ?? null, toPrice: t?.relative_price ?? null,
    priceSource: f && t ? (f.price_source === 'published' && t.price_source === 'published' ? 'published' : 'estimated') : null,
    rewrite: !!rewrite, newChat: !!newChat, sent: !!sent,
    threadTokens: newChat ? Math.max(0, Math.round(threadTokens ?? 0)) : 0,
  });
}

const TIERS = ['small', 'medium', 'large'];

// Model mix (share of evaluated prompts per model size): "before" = the model each prompt was on at
// Evaluate; "after" = the same, with each confirmed switch moved to the model it went to.
function modelMix(evals, switched, tierOf) {
  const count = () => Object.fromEntries(TIERS.map((t) => [t, 0]));
  const before = count();
  for (const e of evals) if (tierOf(e.from)) before[tierOf(e.from)] += 1;
  const after = { ...before };
  for (const e of switched) {
    const [f, t] = [tierOf(e.from), tierOf(e.to)];
    if (f && t && after[f] > 0) { after[f] -= 1; after[t] += 1; }
  }
  return { before, after, n: TIERS.reduce((n, t) => n + before[t], 0) };
}

/**
 * Summary since `sinceTs` (ms; 0 = all time):
 * { evaluates, rightFit, applied, sent, down: { n, pctLess, basis }, up, effortLowered, rewrites,
 *   freshChats, tokensLeftBehind, mix: { before, after, n }, recent: [...], firstTs }
 * pctLess: estimated cost of the messages switched to a cheaper model, versus staying on the model the
 * user had (same message on both; relative prices from the catalogue at the time).
 */
export async function getMileage({ sinceTs = 0, site = 'claude' } = {}) {
  const [{ [KEY]: log = [] }, catalogue] = await Promise.all([chrome.storage.local.get(KEY), getCatalogue(site)]);
  const byId = new Map(catalogue.map((m) => [m.id, m]));
  const families = (await loadConfig('models')).sites?.[site]?.families ?? {};
  // Models no longer in the picker (older entries in the log): name and size from the id,
  // e.g. "claude-sonnet-4-6" -> "Sonnet 4.6", tier of the sonnet family.
  const parsed = (id) => {
    const m = String(id ?? '').match(/^[a-z]+-([a-z]+)-(\d+(?:-\d+)*)$/);
    return m ? { label: `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2].replace(/-/g, '.')}`, tier: families[m[1]]?.tier } : null;
  };
  const tierOf = (id) => [byId.get(id)?.tier, parsed(id)?.tier].find((t) => TIERS.includes(t)) ?? null;
  const label = (id) => byId.get(id)?.label ?? parsed(id)?.label ?? id;
  const rows = log.filter((e) => e.ts >= sinceTs);
  const evals = rows.filter((e) => e.kind === 'evaluate');
  const applies = rows.filter((e) => e.kind === 'apply');
  const switched = applies.filter((e) => e.from && e.to && e.from !== e.to && e.fromPrice && e.toPrice);
  const down = switched.filter((e) => e.toPrice < e.fromPrice);
  const up = switched.filter((e) => e.toPrice > e.fromPrice);
  const sum = (xs, k) => xs.reduce((n, e) => n + e[k], 0);
  const lowered = applies.filter((e) => e.fromEffort && e.toEffort && EFFORTS.indexOf(e.toEffort) < EFFORTS.indexOf(e.fromEffort));
  const fresh = applies.filter((e) => e.newChat);
  return {
    evaluates: evals.length,
    rightFit: evals.filter((e) => e.fits).length,
    applied: applies.length,
    sent: applies.filter((e) => e.sent).length,
    down: {
      n: down.length,
      pctLess: down.length ? Math.round(100 * (1 - sum(down, 'toPrice') / sum(down, 'fromPrice'))) : null,
      basis: down.length && down.every((e) => e.priceSource === 'published') ? 'published' : 'estimated',
    },
    up: up.length,
    effortLowered: lowered.length,
    rewrites: applies.filter((e) => e.rewrite).length,
    freshChats: fresh.length,
    tokensLeftBehind: sum(fresh, 'threadTokens'),
    mix: modelMix(evals, switched, tierOf),
    // Latest confirmed changes, newest first (model labels, efforts and flags only).
    recent: applies.slice(-8).reverse().map((e) => ({
      ts: e.ts, from: e.from && label(e.from), to: e.to && label(e.to),
      fromEffort: e.fromEffort, toEffort: e.toEffort,
      ratio: e.fromPrice && e.toPrice && e.from !== e.to ? e.toPrice / e.fromPrice : null, // new model's price / old
      rewrite: e.rewrite, newChat: e.newChat, sent: e.sent, threadTokens: e.threadTokens,
    })),
    firstTs: log[0]?.ts ?? null,
  };
}
