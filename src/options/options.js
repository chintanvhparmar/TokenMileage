import { getSettings, saveSettings } from '../shared/settings.js';
import { loadConfig, modelFor } from '../shared/config.js';

const $ = (id) => document.getElementById(id);
const form = $('form');

function setStatus(text, kind = '') {
  $('status').textContent = text;
  $('status').className = kind;
}

async function load() {
  const [s, cfg] = await Promise.all([getSettings(), loadConfig('tokenfactory')]);
  $('apiKey').value = s.apiKey;
  $('tavilyKey').value = s.tavilyKey;
  $('baseUrl').value = s.baseUrl;
  $('baseUrl').placeholder = cfg.baseUrl;
  showModels(cfg);
  form.planType.value = s.planType;
  $('fixedFee').checked = s.fixedFee;
  syncFixedFee();
  $('site-claude').checked = s.sites.claude;
  for (const k of ALERT_FIELDS) $(k).value = s.alerts[k];
  refreshUsage();
  refreshAdvice();
  renderModels();
}

// ---- Models on claude.ai: what the picker shows + researched facts (Nemotron + Tavily) ----
const SITE = 'claude';
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return e;
};
const date = (ts) => (ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
// "https://www.anthropic.com/news/claude-opus-4-6" -> "anthropic.com/…/claude-opus-4-6" (host + last path part).
const host = (u) => {
  try {
    const url = new URL(u);
    const parts = url.pathname.split('/').filter(Boolean);
    const h = url.hostname.replace(/^www\./, '');
    return parts.length ? `${h}/${parts.length > 1 ? '…/' : ''}${parts.at(-1)}` : h;
  } catch {
    return u;
  }
};

async function renderModels() {
  const res = await send('tm/models', { site: SITE });
  if (!res?.ok) return;
  const list = res.data;
  const { siteModels = {} } = await chrome.storage.local.get('siteModels');
  const scan = siteModels[SITE]?.fullScanAt;
  $('modelsNote').textContent = scan
    ? `${list.length} models read from claude.ai's model menu on ${date(scan)} (re-read daily when you click Evaluate).`
    : 'Not read from claude.ai yet: click Evaluate on claude.ai once. Until then, the built-in list is used.';
  const price = (m) => [
    el('div', { className: 'name', textContent: m.relative_price == null ? '?' : `${m.relative_price}×` }),
    m.api_price_per_mtok ? el('div', { className: 'desc', textContent: `$${m.api_price_per_mtok.input} / $${m.api_price_per_mtok.output} per M tokens` }) : null,
    el('span', { className: `tag ${m.price_source}`, textContent: m.price_source }),
  ];
  const status = (m) => {
    const r = m.researched;
    if (!r) return 'not yet';
    if (r.status === 'running') return 'researching…';
    if (r.status === 'failed') return el('span', { className: 'err', textContent: `failed ${date(r.checkedAt)}` });
    return `${date(r.checkedAt)}${r.method === 'pipeline' ? ' (fixed steps)' : ''}`;
  };
  $('modelTable').replaceChildren(
    el('tr', {}, ['Model', 'Size', 'Cost vs cheapest', 'Best for', 'Researched', ''].map((t) => el('th', { textContent: t }))),
    ...list.map((m) => el('tr', {},
      el('td', {}, el('div', { className: 'name', textContent: m.label }), m.description ? el('div', { className: 'desc', textContent: m.description }) : null),
      el('td', { textContent: m.tier ?? '?' }),
      el('td', {}, price(m)),
      el('td', {},
        el('div', { textContent: m.best_for.join(', ') || '–' }),
        m.best_for_source === 'web'
          ? el('div', { className: 'src' }, m.sources.map((u, i) => [i ? ' · ' : '', el('a', { href: u, target: '_blank', textContent: host(u) })]))
          : m.best_for_source === 'family' ? el('div', { className: 'src', textContent: 'typical for the family' }) : null),
      el('td', {}, status(m)),
      el('td', {}, el('button', {
        type: 'button',
        className: 'btn secondary',
        textContent: 'Re-check',
        disabled: m.researched?.status === 'running',
        onclick: async (e) => {
          e.target.disabled = true;
          const r = await send('tm/researchModel', { site: SITE, id: m.id });
          if (!r?.ok) $('researchStatus').textContent = r?.error ?? 'Research failed.';
          renderModels();
        },
      })),
    )),
  );
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.modelResearch || changes.siteModels)) renderModels();
  if (area === 'local' && changes.usageLog) refreshUsage();
});

$('researchAll').addEventListener('click', async () => {
  await save();
  const { tavilyKey, apiKey } = await getSettings();
  if (!tavilyKey || !apiKey) {
    $('researchStatus').textContent = 'Add both the Nebius and the Tavily API keys first.';
    return;
  }
  $('researchStatus').textContent = 'Researching in the background, one model at a time…';
  send('tm/researchAll', { site: SITE });
});

const ALERT_FIELDS = ['nearLimitPct', 'slowDownPace', 'useItPace', 'hideMinutes'];

async function refreshAdvice() {
  const res = await chrome.runtime.sendMessage({ type: 'tm/usageAdvice' });
  $('usageAdvice').textContent = res?.ok ? `${res.data.title}. ${res.data.text}` : '–';
}

// Read-only: which Nemotron each built feature uses (config/tokenfactory.json taskModels).
const FEATURE_NAMES = { evaluate: 'Evaluate', research: 'Model research agent (with Tavily)' };
function showModels(cfg) {
  $('models').replaceChildren(...Object.keys(cfg.taskModels ?? {}).map((feature) => {
    const li = document.createElement('li');
    li.textContent = `${FEATURE_NAMES[feature] ?? feature} → ${modelFor(cfg, feature).name}`;
    return li;
  }));
}

// The fixed-fee toggle only applies to spend-limit plans.
function syncFixedFee() {
  const hidden = form.planType.value !== 'spend';
  $('fixedFeeRow').hidden = hidden;
  $('fixedFeeHint').hidden = hidden;
}
form.addEventListener('change', (e) => {
  if (e.target.name === 'planType') syncFixedFee();
});

async function save() {
  const { sites, alerts } = await getSettings();
  const next = { ...alerts };
  for (const k of ALERT_FIELDS) {
    const v = Number($(k).value);
    if ($(k).value !== '' && Number.isFinite(v)) next[k] = v;
  }
  return saveSettings({
    apiKey: $('apiKey').value.trim(),
    tavilyKey: $('tavilyKey').value.trim(),
    baseUrl: $('baseUrl').value.trim(),
    planType: form.planType.value,
    fixedFee: $('fixedFee').checked,
    sites: { ...sites, claude: $('site-claude').checked },
    alerts: next,
  });
}

async function refreshUsage() {
  const res = await chrome.runtime.sendMessage({ type: 'tm/usageSummary' });
  if (!res?.ok) return;
  const u = res.data;
  $('usage').textContent =
    `${u.calls} calls · ${u.prompt_tokens.toLocaleString()} in / ${u.completion_tokens.toLocaleString()} out tokens · ` +
    `≈ $${u.est_cost_usd.toFixed(4)} (estimate from config prices)` +
    (u.tavily_calls ? ` · Tavily: ${u.tavily_calls} calls, ${u.tavily_credits} credits` : '');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  await save();
  setStatus('Saved.', 'ok');
  refreshAdvice(); // plan type and thresholds change the advice
});

$('test').addEventListener('click', async () => {
  await save();
  setStatus('Testing…');
  const res = await chrome.runtime.sendMessage({ type: 'tm/testConnection' });
  if (!res?.ok) return setStatus(res?.error ?? 'Test failed.', 'err');
  const d = res.data;
  let tavilyNote = '';
  if ($('tavilyKey').value.trim()) {
    const t = await chrome.runtime.sendMessage({ type: 'tm/testTavily' });
    tavilyNote = t?.ok ? ' Tavily connected.' : ` Tavily: ${t?.error ?? 'test failed'}.`;
  }
  if (!d.missing.length) {
    setStatus(`Connected. Available: ${d.usedModels.join(', ')}.${tavilyNote}`, 'ok');
  } else {
    const hint = d.nemotronIds.length ? ` Nemotron IDs found: ${d.nemotronIds.join(', ')}` : '';
    setStatus(`Connected (${d.modelCount} models), but not found: ${d.missing.join(', ')}.${hint}`, 'err');
  }
});

load();
