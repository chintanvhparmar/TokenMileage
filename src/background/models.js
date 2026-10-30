// The models the user can pick on each site. Names and descriptions come from the site's own picker
// (content script), facts from config/models.json (families, estimated prices) and from research.js
// (best-for and published API prices found on the vendor's site via Tavily, with sources).
import { loadConfig } from '../shared/config.js';

const SEEN = 'siteModels';    // { [site]: { fullScanAt, models: { [name]: { name, description, seenAt } } } }
const RESEARCH = 'modelResearch'; // { [id]: { status, checkedAt, best_for, size_class, api_price_per_mtok, ... } }
const SCAN_EVERY_MS = 24 * 36e5;

// "Sonnet 5.5" on claude -> "claude-sonnet-5-5" (the same ids config/models.json uses).
export const modelId = (site, name) => `${site}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;

// Picker descriptions without icon glyphs (private-use characters) or check marks.
const cleanText = (s) => String(s ?? '').replace(/[\p{Co}✓✔�]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 160);

const store = async (key) => (await chrome.storage.local.get(key))[key] ?? {};

export async function modelScanDue({ site }) {
  const s = (await store(SEEN))[site];
  return !s?.fullScanAt || Date.now() - s.fullScanAt > SCAN_EVERY_MS;
}

// From the content script. full = the whole menu was read (incl. "More models"): it replaces the list.
// Otherwise (the user opened the menu) entries are added. Returns the names not seen before.
export async function modelsSeen({ site, models, full }) {
  const clean = (models ?? [])
    .filter((m) => typeof m?.name === 'string' && /^[\w .-]{2,40}$/.test(m.name))
    .slice(0, 40)
    .map((m) => ({ name: m.name.trim(), description: cleanText(m.description) }));
  if (!clean.length) return { added: [] };
  const all = await store(SEEN);
  const s = all[site] ?? { models: {} };
  const before = new Set(Object.keys(s.models));
  const now = Date.now();
  const next = full ? {} : { ...s.models };
  for (const m of clean) next[m.name] = { ...m, description: m.description || s.models[m.name]?.description || '', seenAt: now };
  all[site] = { ...s, models: next, fullScanAt: full ? now : s.fullScanAt };
  await chrome.storage.local.set({ [SEEN]: all });
  return { added: clean.map((m) => m.name).filter((n) => !before.has(n)) };
}

export async function getResearch() {
  return store(RESEARCH);
}

export async function saveResearch(id, entry) {
  const all = await store(RESEARCH);
  all[id] = entry;
  await chrome.storage.local.set({ [RESEARCH]: all });
}

/**
 * The catalogue Evaluate chooses from. Each entry:
 * { id, label, aliases, tier, relative_price, price_source, best_for, best_for_source, description, sources, researched }
 * price_source: 'published' (vendor API prices found by research) | 'estimated' (config) | 'unknown'.
 * Before the picker has been fully read, the config list and any models seen so far are combined.
 */
export async function getCatalogue(site, { currentLabel } = {}) {
  const [cfg, seenAll, research] = await Promise.all([loadConfig('models'), store(SEEN), store(RESEARCH)]);
  const siteCfg = cfg.sites[site] ?? {};
  const known = siteCfg.models ?? [];
  const families = siteCfg.families ?? {};
  const seen = seenAll[site];

  const names = new Map(); // name -> picker description
  Object.values(seen?.models ?? {}).forEach((m) => names.set(m.name, m.description));
  // The config's current lineup is always included: claude.ai's 2026-10-29 picker layout made the menu
  // read miss models (only Haiku was kept), and Evaluate then had nothing to compare against.
  known.forEach((k) => { if (![...names.keys()].some((n) => n.toLowerCase() === k.label.toLowerCase())) names.set(k.label, ''); });
  // The model the picker shows right now is available even if the last menu read missed it
  // (2026-10-29: claude.ai's new picker layout, the scan dropped the current model).
  const current = String(currentLabel ?? '').replace(/\s+/g, ' ').match(/^(?:Claude )?([A-Z][a-z]+(?: [A-Z][a-z]+)? \d+(?:\.\d+)*)\b/)?.[1];
  if (current && ![...names.keys()].some((n) => n.toLowerCase() === current.toLowerCase())) names.set(current, '');
  const fromPicker = !!seen?.fullScanAt;

  const entries = [...names].map(([name, description]) => {
    const id = modelId(site, name);
    const k = known.find((m) => m.id === id);
    const f = families[name.split(' ')[0].toLowerCase()];
    const r = research[id]?.status === 'done' ? research[id] : null;
    const bestFor = r?.best_for?.length ? ['web', r.best_for] : k?.best_for ? ['config', k.best_for] : f?.best_for ? ['family', f.best_for] : [null, []];
    return {
      id,
      label: name,
      family: name.split(' ')[0].toLowerCase(),
      // Family aliases ("opus") only for the config fallback list: with the picker read, the exact name is there.
      aliases: fromPicker ? [] : k?.aliases ?? [],
      tier: k?.tier ?? f?.tier ?? r?.size_class ?? null,
      estimate: k?.relative_price ?? f?.relative_price ?? null,
      api: r?.api_price_per_mtok ?? null,
      best_for: bestFor[1],
      best_for_source: bestFor[0],
      description: cleanText(description) || null, // also cleans descriptions stored before the fix
      sources: r?.sources ?? [],
      researched: research[id] ? { status: research[id].status, checkedAt: research[id].checkedAt, method: research[id].method } : null,
    };
  });
  return priced(entries);
}

// relative_price on one scale: usage cost versus the cheapest model in the list (= 1).
// - Published API prices give exact ratios.
// - A model without one is estimated on the same scale: the median published price of its family
//   (an old Opus costs like the other Opus models), else its config estimate scaled by how published
//   prices compare with config estimates. With no published prices at all, config estimates are used.
function priced(entries) {
  const blended = (p) => p.input + p.output;
  const published = entries.filter((e) => e.api);
  const cheapest = Math.min(...published.map((e) => blended(e.api)));
  const rel = (e) => blended(e.api) / cheapest;
  const familyRel = (fam) => median(published.filter((e) => e.family === fam).map(rel));
  const scale = median(published.filter((e) => e.estimate != null).map((e) => rel(e) / e.estimate)) ?? 1;
  return entries.map(({ estimate, api, family, ...e }) => {
    const base = { ...e, family, api_price_per_mtok: api };
    if (api) return { ...base, relative_price: round(rel({ api })), price_source: 'published' };
    const est = familyRel(family) ?? (estimate != null ? estimate * scale : null);
    return est != null
      ? { ...base, relative_price: round(est), price_source: 'estimated' }
      : { ...base, relative_price: null, price_source: 'unknown' };
  });
}
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}
const round = (n) => (n >= 10 ? Math.round(n) : Math.round(n * 10) / 10);
