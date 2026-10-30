// Dashboard: outcomes of Apply / Apply & send (background/outcomes.js), plan pacing (background/usage.js)
// and TokenMileage's own costs (background/usageLog.js). Numbers, model labels and flags only.
const $ = (id) => document.getElementById(id);
const send = (type, payload) => chrome.runtime.sendMessage({ type, payload });
const el = (tag, props = {}, ...children) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...children.flat(Infinity).filter((c) => c != null && c !== false));
  return e;
};
const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function periodStart(p) {
  const now = new Date();
  if (p === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (p === '30d') return Date.now() - 30 * 864e5;
  return 0;
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---- Hero ----
function renderHero(m, own) {
  const empty = !m.evaluates && !m.applied;
  $('hero').replaceChildren(...(empty
    ? [el('div', { className: 'hero-value', textContent: '–' }),
      el('p', { className: 'hero-text', textContent: 'Nothing yet for this period.' }),
      el('p', { className: 'hero-note', textContent: 'On claude.ai, type a prompt, click Evaluate, then Apply or Apply & send. What changed shows up here.' })]
    : m.down.n
      ? [el('div', { className: 'hero-value', textContent: `${m.down.pctLess}%` }),
        el('p', { className: 'hero-text', textContent: `less usage on the ${plural(m.down.n, 'message')} you moved to a cheaper model` }),
        el('p', { className: 'hero-note', textContent: `Versus staying on the model you had, same message on both (${m.down.basis === 'published' ? 'from published API prices' : 'estimated prices'}).` })]
      : [el('div', { className: 'hero-value', textContent: String(m.evaluates) }),
        el('p', { className: 'hero-text', textContent: `${m.evaluates === 1 ? 'prompt' : 'prompts'} evaluated` }),
        el('p', { className: 'hero-note', textContent: 'Switch to a recommended cheaper model with Apply to see the saving here.' })]));

  const stat = (value, label) => el('li', {}, el('span', { className: 'v', textContent: value }), el('span', { className: 'l', textContent: label }));
  $('heroStats').replaceChildren(
    stat(fmt(m.evaluates), `prompts evaluated · ${m.rightFit} already right-sized`),
    stat(m.tokensLeftBehind ? `~${fmt(m.tokensLeftBehind)}` : '0', 'tokens of chat history not re-sent'),
    stat(own ? `$${own.est_cost_usd.toFixed(own.est_cost_usd < 1 ? 3 : 2)}` : '–', "TokenMileage's own AI cost, all time"),
  );
}

// ---- Levers: why usage grows (left) and what changed (right) ----
function renderLevers(m) {
  const levers = [
    ['Right-size the model', 'Few people change the default model, so quick questions go to the strongest, priciest one.',
      m.down.n, m.down.n ? `moved to a cheaper model, about ${m.down.pctLess}% less on those` : 'moved to a cheaper model'],
    ['Move up when it matters', 'A weak first answer means retries, and retries multiply token use.',
      m.up, 'moved up for a stronger first answer'],
    ['Right effort', 'Extended thinking adds tokens to simple questions where it changes nothing.',
      m.effortLowered, 'times effort was lowered'],
    ['Lean context', 'Every reply re-sends the whole thread, so long chats cost more with each message.',
      m.freshChats, m.tokensLeftBehind ? `fresh chats, ~${fmt(m.tokensLeftBehind)} tokens of history left behind` : 'fresh chats started'],
    ['Right first time', 'Vague prompts lead to follow-ups and corrections.',
      m.rewrites, `prompts rewritten, ${m.sent} sent with Apply & send`],
  ];
  $('levers').replaceChildren(...levers.map(([name, why, value, ctx], i) => el('article', { className: `lever${value ? ' on' : ''}` },
    el('div', { className: 'lever-top' },
      el('span', { className: 'lever-n', textContent: String(i + 1) }),
      el('h3', { textContent: name })),
    el('p', { className: 'why', textContent: why }),
    el('div', { className: 'lever-value', textContent: fmt(value) }),
    el('p', { className: 'ctx', textContent: ctx }))));
}

// ---- Model mix: two 100% bars (before / after), one hue light -> dark by model size ----
const TIERS = [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']];
function renderMix(mix) {
  if (!mix.n) {
    $('mix').replaceChildren(el('p', { className: 'empty', textContent: 'Appears after your first Evaluate on claude.ai.' }));
    return;
  }
  const share = (row, t) => Math.round((100 * row[t]) / mix.n);
  const bar = (title, row) => el('div', { className: 'mix-row' },
    el('span', { className: 'mix-label', textContent: title }),
    el('div', { className: 'mix-bar', role: 'img', ariaLabel: `${title}: ${TIERS.map(([t, n]) => `${n} ${share(row, t)}%`).join(', ')}` },
      TIERS.filter(([t]) => row[t]).map(([t, n]) => el('span', {
        className: `seg ${t}`,
        style: `flex-grow:${row[t]}`,
        title: `${n} models: ${plural(row[t], 'prompt')} (${share(row, t)}%)`,
      }, share(row, t) >= 12 ? `${share(row, t)}%` : ''))));
  const large = [share(mix.before, 'large'), share(mix.after, 'large')];
  $('mix').replaceChildren(
    el('p', { className: 'mix-headline' },
      el('b', { textContent: `${large[0]}% → ${large[1]}%` }), ' of prompts on a large model'),
    bar('Before', mix.before),
    bar('After', mix.after),
    el('ul', { className: 'legend' }, TIERS.map(([t, n]) => el('li', {}, el('i', { className: `sw ${t}` }), n))),
    el('p', { className: 'hint', textContent: `${plural(mix.n, 'prompt')} with a known model. "After" counts only switches you confirmed; large is not always wrong, hard tasks belong there.` }),
  );
}

// ---- Plan pacing: used share with a marker for how much of the period has gone ----
const STATUS = { limit: 'Near the limit', slow: 'Slow down', use: 'Use it before it resets', ok: 'On track', unknown: 'Not read yet' };
function renderPacing(a) {
  const p = a?.forPrompt;
  if (!p) {
    $('pacing').replaceChildren(el('p', { className: 'empty', textContent: a?.text ?? 'Open claude.ai once so TokenMileage can read your usage.' }));
    return;
  }
  $('pacing').replaceChildren(
    el('div', { className: `pace-status ${a.status}` }, el('span', { className: 'dot' }), STATUS[a.status] ?? a.title),
    el('div', { className: 'pace-big', textContent: a.short.split(' · ')[0] }),
    el('div', { className: 'pace-bar', role: 'img', ariaLabel: `${p.used_pct}% used, ${p.period_elapsed_pct}% of the period gone` },
      el('span', { className: `pace-fill ${a.status}`, style: `width:${Math.min(100, p.used_pct)}%` }),
      el('span', { className: 'pace-mark', style: `left:${Math.min(100, p.period_elapsed_pct)}%`, title: `${p.period_elapsed_pct}% of the period gone` })),
    el('div', { className: 'pace-scale' },
      el('span', { textContent: `${p.used_pct}% used` }),
      el('span', { textContent: `${p.period_elapsed_pct}% of the period gone` })),
    el('p', { className: 'pace-text', textContent: a.text }),
    p.projected_pct_at_reset != null ? el('p', { className: 'hint', textContent: `At this pace: ${p.projected_pct_at_reset}% of the allowance used by the reset.` }) : null,
  );
}

// ---- Recent changes ----
function renderFeed(recent) {
  if (!recent.length) {
    $('feed').replaceChildren(el('li', { className: 'empty', textContent: 'No confirmed changes yet in this period.' }));
    return;
  }
  const chip = (text, kind = '') => el('span', { className: `chip ${kind}`, textContent: text });
  $('feed').replaceChildren(...recent.map((r) => {
    const switched = r.from && r.to && r.from !== r.to;
    return el('li', {},
      el('span', { className: 'when', textContent: ago(r.ts) }),
      el('span', { className: 'what' },
        switched ? [el('b', { textContent: r.from }), ' → ', el('b', { textContent: r.to })] : el('b', { textContent: r.to ?? r.from ?? 'Same model' }),
        switched && r.ratio != null ? (r.ratio < 1
          ? chip(`${Math.round(100 * (1 - r.ratio))}% less`, 'down')
          : chip(`${r.ratio >= 10 ? Math.round(r.ratio) : r.ratio.toFixed(1)}× usage, for a better first answer`, 'up')) : null),
      el('span', { className: 'chips' },
        r.fromEffort && r.toEffort && r.fromEffort !== r.toEffort ? chip(`effort ${r.fromEffort} → ${r.toEffort}`) : null,
        r.newChat ? chip(r.threadTokens ? `fresh chat · ~${fmt(r.threadTokens)} tokens left behind` : 'fresh chat') : null,
        r.rewrite ? chip('prompt rewritten') : null,
        chip(r.sent ? 'sent' : 'pre-filled', r.sent ? 'sent' : '')));
  }));
}

async function render() {
  const [mRes, aRes, uRes] = await Promise.all([
    send('tm/mileage', { sinceTs: periodStart($('period').value) }),
    send('tm/usageAdvice'),
    send('tm/usageSummary'),
  ]);
  if (!mRes?.ok) return;
  const m = mRes.data;
  const own = uRes?.ok ? uRes.data : null;
  renderHero(m, own);
  renderLevers(m);
  renderMix(m.mix);
  renderPacing(aRes?.ok ? aRes.data : null);
  renderFeed(m.recent);
  $('foot').textContent = own
    ? `TokenMileage itself: ${plural(own.calls, 'Nemotron call')} on Nebius Token Factory${own.tavily_calls ? `, ${plural(own.tavily_calls, 'Tavily search', 'Tavily searches')}` : ''}, about $${own.est_cost_usd.toFixed(3)} in total. Everything else stays in this browser.`
    : 'Everything stays in this browser.';
}

$('period').addEventListener('change', render);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.outcomes || changes.usageReading || changes.usageLog)) render();
});
render();
