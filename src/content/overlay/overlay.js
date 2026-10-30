// Evaluate button + recommendation card. Site-agnostic: it only uses reader.getComposer().
// Lives in a fixed-position Shadow DOM host on <body>, so the site's CSS can't touch it and
// we never modify the site's own layout. All model output is inserted as text, never HTML.
(() => {
  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
    .btn { font-size: 12px; font-weight: 600; padding: 5px 10px; border-radius: 999px; cursor: pointer;
      border: 1px solid #c9c4b8; background: #fffdf8; color: #2b2a27; box-shadow: 0 1px 3px rgba(0,0,0,.12); }
    .btn:hover { background: #f3efe6; }
    .btn[disabled] { opacity: .6; cursor: progress; }
    .bar { display: flex; align-items: center; gap: 6px; }
    .pill { font-weight: 500; white-space: nowrap; }
    .pill[hidden] { display: none; }
    .pill.ok { color: #1e7b3c; } .pill.use { color: #5b21b6; border-color: #c4b5fd; }
    .pill.warn { color: #8f1d12; border-color: #f4b4a6; }
    .card { position: absolute; right: 0; bottom: calc(100% + 8px); width: 440px; padding: 12px 14px;
      max-height: calc(100vh - 140px); overflow-y: auto; /* refined in position() to the space above */
      border-radius: 12px; border: 1px solid #d8d3c8; background: #fffdf8; color: #2b2a27;
      box-shadow: 0 6px 24px rgba(0,0,0,.18); font-size: 13px; line-height: 1.45; }
    .section { margin: 10px 0 4px; font-size: 12px; font-weight: 600; }
    textarea { display: block; width: 100%; min-height: 64px; max-height: 220px; resize: vertical; padding: 7px 9px;
      font-size: 13px; line-height: 1.4; border-radius: 8px; border: 1px solid #d8d3c8; background: #fff; color: inherit; }
    .actions { display: flex; align-items: center; gap: 8px; margin: 8px 0 4px; }
    .act { font-size: 12px; font-weight: 600; padding: 6px 12px; border-radius: 8px; cursor: pointer;
      border: 1px solid #6d28d9; background: transparent; color: #6d28d9; }
    .act.primary { background: #6d28d9; color: #fff; }
    .act:hover { filter: brightness(1.1); } .act[disabled] { opacity: .6; cursor: progress; }
    .status { font-size: 12px; }
    .toast { position: absolute; right: calc(100% + 8px); top: 0; max-width: 520px; padding: 5px 10px; border-radius: 999px;
      font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      background: #6d28d9; color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.18); }
    .check { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font-size: 12px; cursor: pointer; }
    .check input { accent-color: #6d28d9; margin: 0; }
    .head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
    .title { font-weight: 700; flex: 1; }
    .close { border: 0; background: none; font-size: 16px; cursor: pointer; color: inherit; padding: 0 2px; }
    .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; background: #e8e3d8; }
    .badge.high { background: #cfe8d5; } .badge.medium { background: #dcebd0; }
    .badge.up { background: #ede9fe; color: #5b21b6; }
    .badge.warn { background: #fde2dd; color: #8f1d12; }
    .rec { font-weight: 600; }
    .now { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
    .good { color: #1e7b3c; } .bad { color: #b42318; }
    .muted { color: #6f6b63; font-size: 12px; }
    ul { margin: 8px 0 6px; padding-left: 18px; } li { margin: 2px 0; }
    .err { color: #a3361f; }
    a { color: inherit; cursor: pointer; text-decoration: underline; }
    @media (prefers-color-scheme: dark) {
      .btn, .card { background: #2b2a27; color: #ecebe6; border-color: #4a4843; }
      .btn:hover { background: #3a3834; } .badge { background: #45433e; }
      .badge.high, .badge.medium { background: #2f5138; }
      .badge.up { background: #3b2a63; color: #ddd6fe; }
      .badge.warn { background: #5c2219; color: #fcd3ca; }
      .pill.ok { color: #7fd49a; } .pill.use { color: #c4b5fd; border-color: #6d4fc2; }
      .pill.warn { color: #f19a83; border-color: #8f3a2b; }
      .muted { color: #a9a59c; } .err { color: #f19a83; }
      .good { color: #7fd49a; } .bad { color: #f19a83; }
      textarea { background: #1f1e1c; border-color: #4a4843; }
      .act { border-color: #a78bfa; color: #c4b5fd; } .act.primary { background: #7c3aed; color: #fff; }
    }
  `;

  // Tiny element builder: h('div', { class: 'x' }, 'text', childEl)
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c);
    return el;
  }

  const TOP_GAP = 76; // px kept free at the top of the window (claude.ai's chat title bar is ~70px)

  globalThis.TM = globalThis.TM || {};
  TM.createOverlay = function createOverlay({ reader, onEvaluate, onApply, onOpenOptions, onUsageClosed }) {
    let host = null;
    let root = null;
    let card = null;
    let cardUrl = null;        // the card belongs to one chat: close it on navigation...
    const pageUrl = () => location.href.split('#')[0]; // ...but not when only the #hash changes (settings window)
    let closeOnSend = false;   // ...and a result card also closes once its draft is sent (input empties)
    let timer = null;
    let evalBtn = null;
    let bar = null;           // the row with the usage pill and the Evaluate button
    let usagePill = null;
    let usage = null;         // latest { advice, usageUrl }, kept so a re-mount can show it again
    let applying = false;     // the draft is briefly empty while Apply replaces it: don't close then

    function position() {
      if (card && !applying && (pageUrl() !== cardUrl || (closeOnSend && !reader.getPrompt()))) closeCard();
      const composer = reader.getComposer();
      if (!composer || !host) {
        if (host) host.style.display = 'none';
        return;
      }
      const r = composer.getBoundingClientRect();
      // Hidden (button, cards, notices) while the site's settings window covers the chat.
      host.style.display = r.width && !reader.isSettingsOpen?.() ? 'block' : 'none';
      // Hide just the buttons (not an open card) while the site's own menu is open, so they can't cover it.
      if (bar) bar.style.visibility = reader.isMenuOpen?.() ? 'hidden' : 'visible';
      const top = Math.max(4, r.top - 34);
      host.style.top = `${top}px`;
      host.style.left = `${r.right - host.offsetWidth - 8}px`;
      // The card grows upwards from the button: cap it to the space above, keeping clear of the
      // site's title bar (TOP_GAP); anything longer scrolls inside the card.
      if (card) card.style.maxHeight = `${Math.max(180, top - 8 - TOP_GAP)}px`;
    }

    function closeCard() {
      card?.remove();
      card = null;
    }

    function showCard(...content) {
      closeCard();
      card = h('div', { class: 'card', role: 'dialog' },
        h('div', { class: 'head' },
          h('span', { class: 'title' }, 'TokenMileage'),
          h('button', { class: 'close', title: 'Close', onclick: closeCard }, '×')),
        ...content);
      cardUrl = pageUrl();
      closeOnSend = false;
      root.append(card);
      position(); // size it to the space above straight away, not on the next timer tick
    }


    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    const good = (text) => h('span', { class: 'good' }, text);
    const bad = (text) => h('span', { class: 'bad' }, text);

    // Headline: what to do, with the recommended setup in green. "Now" line: the current setup,
    // red where it doesn't fit and green where it does. A full fit gets a single green line.
    function verdict(r, currentModel, currentEffort, recommendedModel, usageRatio) {
      const recEffort = `${cap(r.effort)} effort`;
      if (!currentModel) return { head: ['Use ', good(`${recommendedModel.label} · ${recEffort}`)], now: null };
      const modelFits = currentModel.id === recommendedModel.id;
      const effortFits = !currentEffort || currentEffort === r.effort;
      if (modelFits && effortFits) return { head: ['✓ Right fit: ', good(`${recommendedModel.label} · ${recEffort}`)], now: null };
      const head = modelFits
        ? ['Keep ', good(recommendedModel.label), ' · change effort to ', good(cap(r.effort))]
        : [usageRatio < 1 ? 'Switch up to ' : 'Switch to ', good(recommendedModel.label), ' · ', good(recEffort)];
      const now = ['Now: ', (modelFits ? good : bad)(currentModel.label)];
      if (currentEffort) now.push(' · ', (effortFits ? good : bad)(`${cap(currentEffort)} effort`));
      return { head, now };
    }

    // Switching up costs more per message but avoids a weak first answer and a retry, so a grey
    // "Saving: none" would undersell it. On a full fit there's nothing to save: no badge.
    function badge(saving, usageRatio, changes) {
      if (usageRatio != null && usageRatio < 1) return h('span', { class: 'badge up' }, 'Fewer retries');
      if (!changes && saving === 'none') return null;
      return h('span', { class: `badge ${saving}` }, `Saving: ${saving}`);
    }

    // "20×", "2.5×", "3×".
    const times = (x) => `${x >= 10 ? Math.round(x) : Number(x.toFixed(1))}×`;

    // Moving up with a fresh chat: the bigger model costs more per token, but the new chat stops
    // re-sending the thread. Input for this message, now (history + draft on the current model) vs after
    // (draft only on the new one); input API prices when both are published, else relative prices.
    // Returns the % less, or null when it isn't cheaper.
    function netInputLess(from, to, threadTokens, draftTokens) {
      if (!threadTokens || !from || !to) return null;
      const both = from.api_price_per_mtok?.input && to.api_price_per_mtok?.input;
      const [pf, pt] = both ? [from.api_price_per_mtok.input, to.api_price_per_mtok.input] : [from.relative_price, to.relative_price];
      if (!pf || !pt) return null;
      const d = Math.max(draftTokens, 50); // a draft we couldn't measure still has some length
      const now = (threadTokens + d) * pf;
      const after = d * pt;
      return after < now ? Math.min(99, Math.round(100 * (1 - after / now))) : null;
    }
    const kTokens = (n) => `~${Math.round(n / 1000)}k`;

    function renderResult({ result, currentModel, currentEffort, recommendedModel, usageRatio, seen }, prompt) {
      const r = result.recommend;
      const same = currentModel && currentModel.id === recommendedModel.id;
      // "published": both prices come from the vendor's API price list (model research); else estimates.
      const basis = currentModel?.price_source === 'published' && recommendedModel.price_source === 'published'
        ? 'from published API prices' : 'estimate';
      const thread = seen.thread.approx_tokens ?? 0;
      const draftTokens = Math.ceil((result.revised_prompt ?? prompt ?? '').length / 4);
      let compare;
      // Say which step failed: no picker found on the page, or a picker label that isn't in the model list.
      if (!currentModel) compare = seen.modelLabel
        ? `Your picker shows “${seen.modelLabel.replace(/\s+/g, ' ')}”, which isn’t in TokenMileage’s model list.`
        : 'Couldn’t find the model picker on the page.';
      else if (same) compare = null;
      else if (usageRatio == null) compare = `Price of ${[currentModel, recommendedModel].find((m) => m.relative_price == null)?.label ?? 'one model'} not known yet.`;
      else if (usageRatio > 1) compare = `${currentModel.label} uses about ${times(usageRatio)} the allowance for this task (${basis}).`;
      else {
        const less = r.fresh_chat ? netInputLess(currentModel, recommendedModel, thread, draftTokens) : null;
        compare = less != null
          ? `${recommendedModel.label} costs about ${times(1 / usageRatio)} as much per token (${basis}), but a new chat stops re-sending ${kTokens(thread)} tokens of history: about ${less}% less input for this message. A weak first answer costs a retry.`
          : `This task likely needs a stronger model (about ${times(1 / usageRatio)} the usage per token, ${basis}). A weak first answer costs a retry.`;
      }
      const { head, now } = verdict(r, currentModel, currentEffort, recommendedModel, usageRatio);
      const nowEl = h('div', { class: 'now' }, now ?? []); // empty until there's something to show
      const compareEl = compare ? h('div', { class: 'muted' }, compare) : null;

      showCard(
        h('div', { class: 'head' },
          h('span', { class: 'rec' }, head),
          badge(result.est_relative_usage_saving, usageRatio, !!(now || compare))),
        nowEl,
        compareEl,
        same ? null : modelFacts(recommendedModel),
        result.tips.length ? h('ul', {}, result.tips.map((t) => h('li', {}, t))) : null,
        actions(result, currentModel, currentEffort, recommendedModel, seen, (model, effort) => {
          // After a confirmed switch the "Now" line shows the new setup in green.
          nowEl?.replaceChildren('Now: ', good(`${model.label}${effort ? ` · ${cap(effort)} effort` : ''}`), ' ✓');
          compareEl?.remove();
        }),
      );
      closeOnSend = true;
    }

    // After a confirmed switch: what it means for this message, e.g. " About 96% less than Opus 4.6 for this message."
    function mileageNote(from, to, { newChat, threadTokens, draftTokens }) {
      if (!from?.relative_price || !to?.relative_price || from.id === to.id) return '';
      const basis = from.price_source === 'published' && to.price_source === 'published' ? 'published prices' : 'estimate';
      if (to.relative_price < from.relative_price) {
        return ` About ${Math.round(100 * (1 - to.relative_price / from.relative_price))}% less than ${from.label} for this message (${basis}).`;
      }
      const less = newChat ? netInputLess(from, to, threadTokens, draftTokens) : null;
      return less != null
        ? ` A stronger model for a better first answer, and about ${less}% less input than staying in the old chat (${basis}).`
        : ` A stronger model for a better first answer (${times(to.relative_price / from.relative_price)} the usage per token, ${basis}).`;
    }

    // "Sonnet 5.5: good for everyday coding, writing · anthropic.com". Researched facts link their source;
    // family defaults are marked as such.
    function modelFacts(m) {
      if (!m?.best_for?.length) return null;
      const src = m.best_for_source === 'web' && /^https:\/\//.test(m.sources?.[0] ?? '') && m.sources[0];
      let host = null;
      try { host = src && new URL(src).hostname.replace(/^www\./, ''); } catch { /* not a URL */ }
      return h('div', { class: 'muted' },
        `${m.label}: good for ${m.best_for.slice(0, 3).join(', ')}`,
        host ? [' · ', h('a', { href: src, target: '_blank', rel: 'noopener' }, host)] : m.best_for_source === 'family' ? ' (typical for this family)' : null);
    }

    // Suggested prompt (editable) + "Apply" / "Apply & send". Nothing happens without a click here,
    // and the page side refuses to send unless every change is confirmed.
    function actions(result, currentModel, currentEffort, recommendedModel, seen, onSwitched) {
      const r = result.recommend;
      const modelOff = !currentModel || currentModel.id !== recommendedModel.id;
      const effortOff = !!currentEffort && currentEffort !== r.effort;
      const model = modelOff || effortOff ? recommendedModel : null;
      const effort = model && currentEffort ? r.effort : null; // only touch effort if the picker shows one
      const revised = result.revised_prompt;
      const fresh = r.fresh_chat;
      if (!revised && !model && !fresh) return null;

      // Fresh-chat advice: offered as a checkbox (ticked), so the buttons can move the draft to a new chat.
      let freshBox = null;
      if (fresh) {
        freshBox = h('input', { type: 'checkbox' });
        freshBox.checked = true;
      }
      // "(34 turns so far; this one re-sends ~202k tokens with every message)". 'page' = only the rendered
      // messages were counted, which is low for long chats, hence "34+".
      const k = Math.round((seen.thread.approx_tokens ?? 0) / 1000);
      const t = seen.thread.turns;
      const why = [
        t && `${t}${seen.thread.source === 'page' ? '+' : ''} ${t === 1 ? 'turn' : 'turns'} so far`,
        k && `this one re-sends ~${k}k tokens with every message`,
      ].filter(Boolean).join('; ');
      const freshRow = fresh
        ? h('label', { class: 'check' }, freshBox, ` Start a new chat${why ? ` (${why})` : ''}`)
        : null;

      let box = null;
      if (revised) {
        box = h('textarea', { spellcheck: 'false', 'aria-label': 'Suggested prompt' });
        box.value = revised;
        // Grow to fit the text (up to the CSS max-height), once it's on screen and as the user edits.
        const fit = () => { box.style.height = 'auto'; box.style.height = `${box.scrollHeight + 2}px`; };
        box.addEventListener('input', fit);
        requestAnimationFrame(fit);
        // Keep typing inside the card: don't let the site's keyboard shortcuts see it.
        for (const type of ['keydown', 'keyup', 'keypress']) {
          box.addEventListener(type, (e) => { if (e.key !== 'Escape') e.stopPropagation(); });
        }
      }
      const newChat = () => !!freshBox?.checked;
      const status = h('span', { class: 'status muted' });
      const apply = h('button', { class: 'act' });
      const applySend = h('button', { class: 'act primary' });
      // Button words and the "Will …" line follow the checkbox.
      function describe() {
        const will = [
          newChat() && 'open a new chat',
          revised ? 'use this prompt' : newChat() && 'move your prompt there',
          model && `switch to ${model.label}${effort ? ` · ${cap(effort)} effort` : ''}`,
        ].filter(Boolean);
        const noun = revised ? 'Apply' : model ? 'Switch' : 'Move';
        apply.textContent = noun;
        applySend.textContent = `${noun} & send`;
        const nothing = !will.length;
        apply.disabled = applySend.disabled = nothing;
        status.className = 'status muted';
        status.textContent = nothing ? 'Nothing to change: press send as usual.' : `Will ${will.join(', ').replace(/, ([^,]*)$/, ' and $1')}.`;
      }
      freshBox?.addEventListener('change', describe);
      describe();

      async function run(andSend) {
        const text = box?.value.trim();
        if (box && !text) { status.textContent = 'The prompt is empty.'; return; }
        apply.disabled = applySend.disabled = true;
        status.className = 'status muted';
        status.textContent = andSend ? 'Applying and sending…' : 'Applying…';
        applying = true;
        try {
          const outcome = {
            from: currentModel?.id ?? null,
            to: model?.id ?? currentModel?.id ?? null,
            fromEffort: currentEffort ?? null,
            toEffort: effort ?? currentEffort ?? null,
            rewrite: !!text,
            threadTokens: seen.thread.approx_tokens ?? 0,
          };
          const res = await onApply({ prompt: text || null, model, effort, andSend, newChat: newChat(), outcome });
          if (res.navigated) cardUrl = pageUrl(); // the card follows the draft into the new chat
          status.className = `status ${res.ok ? 'good' : 'err'}`;
          const note = mileageNote(currentModel, model, {
            newChat: newChat(), threadTokens: outcome.threadTokens, draftTokens: Math.ceil((text ?? '').length / 4),
          });
          status.textContent = res.ok ? `${res.message}${note}` : res.message;
          if (res.ok && model) onSwitched(model, effort);
        } finally {
          applying = false;
          apply.disabled = applySend.disabled = false;
        }
      }
      apply.addEventListener('click', () => run(false));
      applySend.addEventListener('click', () => run(true));

      return h('div', {},
        revised ? h('div', { class: 'section' }, 'Suggested prompt (edit if you like)') : null,
        box,
        freshRow,
        h('div', { class: 'actions' }, apply, applySend),
        status);
    }

    // Usage advice on page load: "use it" / "slow down" / "near limit"; "on track" is just a toast.
    const USAGE_BADGE = { limit: ['warn', 'Near limit'], slow: ['warn', 'Slow down'], use: ['up', 'Use it'] };
    const PILL_CLASS = { limit: 'warn', slow: 'warn', use: 'use', ok: 'ok' };

    // Pill next to Evaluate: "$122 of $500 · 24% · resets Sun, Nov 1". Click: the full usage card.
    function renderPill() {
      if (!usagePill) return;
      const a = usage?.advice;
      usagePill.hidden = !a?.short;
      if (!a?.short) return;
      usagePill.className = `btn pill ${PILL_CLASS[a.status] ?? ''}`;
      usagePill.textContent = a.short;
      usagePill.title = `TokenMileage · ${a.title}: ${a.text}`;
    }

    // manual: opened from the pill, so closing it doesn't hide the page-load card.
    function showUsage(advice, usageUrl, manual = false) {
      const ago = advice.readAt ? Math.round((Date.now() - new Date(advice.readAt)) / 60000) : null;
      const read = ago == null ? null
        : `Usage read ${ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} d ago`}`;
      if (advice.status === 'ok' && !manual) {
        toast(`${advice.title}. ${advice.text}`, 10000);
        return;
      }
      const [cls, label] = USAGE_BADGE[advice.status] ?? ['', 'Usage'];
      showCard(
        h('div', { class: 'head' }, h('span', { class: 'rec' }, advice.title), h('span', { class: `badge ${cls}` }, label)),
        h('div', {}, advice.text),
        advice.tips.length ? h('ul', {}, advice.tips.map((t) => h('li', {}, t))) : null,
        h('div', { class: 'muted' },
          read ? `${read}${advice.source === 'page' ? ' from Settings → Usage' : ''}. ` : '',
          usageUrl ? h('a', { href: usageUrl }, advice.status === 'unknown' ? 'Open usage page' : 'Update') : null),
      );
      // × hides this advice for the minutes set on the options page.
      card.dataset.kind = 'usage';
      if (!manual) card.querySelector('.close').addEventListener('click', () => onUsageClosed?.(advice.status));
    }

    function renderError(res) {
      const fixLink = ['no_key', 'auth'].includes(res.code)
        ? h('a', { onclick: onOpenOptions }, 'Open TokenMileage options')
        : null;
      showCard(h('div', { class: 'err' }, res.error || 'Something went wrong.'), fixLink);
    }

    async function evaluateClicked(btn) {
      closeCard();
      const prompt = reader.getPrompt();
      btn.disabled = true;
      btn.textContent = 'Asking Nemotron…';
      try {
        const res = await onEvaluate(prompt);
        res.ok ? renderResult(res.data, prompt) : renderError(res);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Evaluate';
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') closeCard();
    }

    let toastEl = null;
    let toastTimer = null;

    // Short notice next to the Evaluate button (e.g. "On track. $76 of $500 used…").
    function toast(text, ms = 7000) {
      if (!root) return;
      toastEl?.remove();
      clearTimeout(toastTimer);
      toastEl = h('div', { class: 'toast', role: 'status', title: text }, `TokenMileage: ${text}`);
      root.append(toastEl);
      toastTimer = setTimeout(() => { toastEl?.remove(); toastEl = null; }, ms);
    }

    return {
      toast,
      showUsage(advice, usageUrl) {
        if (root) showUsage(advice, usageUrl);
      },
      // Latest usage advice for the pill (every check, including badge-only ones).
      setUsage(advice, usageUrl) {
        usage = { advice, usageUrl };
        renderPill();
      },
      mount() {
        if (host) return;
        host = h('div', { id: 'tokenmileage-overlay' });
        Object.assign(host.style, { position: 'fixed', zIndex: '2147483000', display: 'none' });
        root = host.attachShadow({ mode: 'closed' });
        const btn = h('button', { class: 'btn', title: 'TokenMileage: right-size this prompt' }, 'Evaluate');
        evalBtn = btn;
        btn.addEventListener('click', () => evaluateClicked(btn));
        usagePill = h('button', { class: 'btn pill' });
        usagePill.hidden = true;
        // Click toggles the full usage card.
        usagePill.addEventListener('click', () => {
          if (card?.dataset.kind === 'usage') closeCard();
          else if (usage) showUsage(usage.advice, usage.usageUrl, true);
        });
        bar = h('div', { class: 'bar' }, usagePill, btn);
        root.append(h('style', {}, STYLE), bar);
        renderPill();
        document.body.append(host);
        // claude.ai is a single-page app that re-renders the composer, so re-anchor on a short timer.
        timer = setInterval(position, 400);
        window.addEventListener('resize', position);
        document.addEventListener('keydown', onKey);
        position();
      },
      unmount() {
        clearInterval(timer);
        window.removeEventListener('resize', position);
        document.removeEventListener('keydown', onKey);
        host?.remove();
        host = root = card = evalBtn = bar = usagePill = null;
      },
    };
  };
})();
