// Claude reader. ALL claude.ai DOM selectors live here; when claude.ai changes, only this file should break.
// Each selector list is tried in order, first match wins.
(() => {
  const SEL = {
    editor: [
      'div.ProseMirror[contenteditable="true"]',
      'fieldset [contenteditable="true"]',
      '[contenteditable="true"][role="textbox"]',
    ],
    modelButton: [
      'button[data-testid="model-selector-dropdown"]',
      '[data-testid="model-selector"] button',
      // 2026-10-29 DOM: picker under the composer, next to the disclaimer ("Opus 5.5  Medium")
      'button[data-cds="ModelSelector"]',
      '[data-chorus-callout="model-selector"] button',
    ],
    // Sidebar "+ New" link (a client-side route, so the page doesn't reload and this script keeps running).
    newChat: [
      'a[href="/new"]',
      '[data-testid="new-chat-button"]',
      'a[aria-label*="new chat" i]',
      'button[aria-label*="new chat" i]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button[aria-label*="send" i]',
      'fieldset button[type="submit"]',
    ],
    // Open model-picker menu and its entries. 2026-10-24 DOM, role=menu with role=menuitemradio entries:
    // - wide window: current model ("Sonnet 5.5 | Most efficient…"), "Effort  Medium ›" and "More models ›",
    //   each › opening a submenu (Low / Medium [Recommended] / High / Extra; Opus 5.5, Haiku 5.5, … Haiku 4.5)
    // - narrow window (e.g. DevTools open): the same entries shown inline in groups, no submenus.
    menu: ['[role="menu"]', '[role="listbox"]'],
    menuItem: '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]',
    streaming: '[data-is-streaming="true"]', // the reply Claude is still writing
    userMessage: ['[data-testid="user-message"]'],
    // 2026-10-22 DOM: replies are <div data-perf-reply-text class="... standard-markdown ..."> inside [data-transcript-engine-root]
    assistantMessage: ['[data-perf-reply-text]', '.standard-markdown', '.font-claude-response', '[data-is-streaming]'],
  };

  // claude.ai navigates without page reloads and can leave old, hidden composers in the DOM,
  // so take the last VISIBLE match rather than the first match.
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const first = (list) => {
    for (const s of list) {
      const els = [...document.querySelectorAll(s)].filter(visible);
      if (els.length) return els[els.length - 1];
    }
    return null;
  };
  // The picker has no test id in some layouts (e.g. shown under the composer, next to the disclaimer,
  // as "Opus 5.5  Medium"). Fallback: a visible button outside the sidebar whose whole text is a model
  // name with a version, optionally followed by an effort level. It may be a <button>, a role=button
  // element or a menu trigger (aria-haspopup); icon glyphs and chevrons are ignored.
  const PICKER_TEXT = /^(?:Claude\s+)?[A-Z][a-z]+(?: [A-Z][a-z]+)? \d+(?:\.\d+)*(?:\s+(?:Low|Medium|High|Extra|Max)\b[^\n]{0,12})?$/;
  const pickerText = (el) => el.innerText.replace(/[\p{Co}\p{So}⌄▾▼›]/gu, ' ').replace(/\s+/g, ' ').trim();
  const modelButton = () => first(SEL.modelButton) ??
    [...document.querySelectorAll('button, [role="button"], [aria-haspopup]')].filter((b) =>
      visible(b) && !b.closest('nav, aside') && PICKER_TEXT.test(pickerText(b))).pop() ?? null;
  const all = (list) => {
    for (const s of list) {
      const els = document.querySelectorAll(s);
      if (els.length) return [...els];
    }
    return [];
  };

  globalThis.TM = globalThis.TM || {};
  TM.siteReader = {
    site: 'claude',

    // The box the Evaluate button anchors to.
    getComposer() {
      const editor = first(SEL.editor);
      if (!editor) return null;
      return editor.closest('fieldset') || editor.parentElement?.parentElement || editor;
    },

    getPrompt() {
      return first(SEL.editor)?.innerText.trim() ?? '';
    },

    // True while one of the site's menus is open (the Evaluate button hides so it can't cover it).
    isMenuOpen() {
      return !!first(SEL.menu);
    },

    // Raw picker text, e.g. "Opus 5.5". Mapped to a catalogue id in the background.
    getModelLabel() {
      return modelButton()?.innerText.trim() || null;
    },

    // ---- Actions (only ever run from a click on the TokenMileage card) ----

    // Replaces the draft. Returns true if the editor now holds exactly `text`.
    async setPrompt(text) {
      const editor = first(SEL.editor);
      if (!editor) return false;
      editor.focus();
      document.execCommand('selectAll');
      // insertText keeps it as typed text (a long paste can become an attachment on claude.ai);
      // lines are joined with paragraph breaks the way Enter would add them.
      text.split('\n').forEach((line, i) => {
        if (i) document.execCommand('insertParagraph');
        if (line) document.execCommand('insertText', false, line);
      });
      await sleep(50);
      if (sameText(this.getPrompt(), text)) return true;

      // Fallback: a synthetic paste, which ProseMirror handles natively.
      document.execCommand('selectAll');
      const data = new DataTransfer();
      data.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      await sleep(100);
      return sameText(this.getPrompt(), text);
    },

    // Picks `model` ({label, aliases}) and, if given, `effort` ('low' | 'medium' | 'high') in the picker.
    // Returns { ok, label } where label is what the picker shows afterwards.
    async selectModel(model, effort) {
      const names = [model.label, ...(model.aliases ?? [])].map((n) => n.toLowerCase());
      const shows = () => {
        const label = (this.getModelLabel() ?? '').toLowerCase();
        return { model: names.some((n) => label.includes(n)), effort: !effort || new RegExp(`\\b${effort}\\b`).test(label) };
      };

      // step: where it failed, shown on the card so a claude.ai change is easy to diagnose.
      let step = null;
      if (!shows().model) {
        const items = await openMenu();
        // Full label first ("haiku 5.5"), so an alias ("haiku") can't pick an older version.
        const item = items.length && await pick((list) =>
          list.find((el) => itemText(el).includes(names[0])) ?? list.find((el) => names.some((n) => itemText(el).includes(n))),
        /^more models/);
        if (!items.length) step = 'menu didn’t open';
        else if (!item) step = `“${model.label}” not in the menu; saw ${menuItems().length} entries: ${menuItems().slice(0, 6).map(itemText).join(' / ')}`;
        else await press(item);
        await closeMenu();
        if (!step && !shows().model) step = `clicked “${model.label}” but the picker didn’t change`;
      }
      if (!step && !shows().effort) {
        // Effort is in the same menu (group "Effort": Low / Medium / High / Extra).
        const items = await openMenu();
        const item = items.length && await pick((list) => list.find((el) => itemText(el) === effort || itemText(el).startsWith(`${effort} `)), /^effort/);
        if (!items.length) step = 'menu didn’t open (effort)';
        else if (!item) step = `effort “${effort}” not in the menu; saw ${menuItems().length} entries: ${menuItems().slice(0, 6).map(itemText).join(' / ')}`;
        else await press(item);
        await closeMenu();
        if (!step && !shows().effort) step = `clicked “${effort}” but the picker didn’t change`;
      }
      const s = shows();
      return { ok: s.model && s.effort, label: this.getModelLabel(), step };
    },

    // ---- Models in the picker: names and the site's own one-line descriptions (no user content) ----

    // Models in the currently open model menu (wherever the user has it open), or [].
    readModelMenu() {
      return modelEntries();
    },

    // Opens the picker and its "More models" submenu, reads every model, closes it again.
    // Only run from a user click (Evaluate). Returns [{ name, description }] or null.
    async scanModels() {
      if (first(SEL.menu)) return null; // a menu is already open: don't interfere with it
      if (!(await openMenu()).length) return null;
      const found = new Map();
      const add = () => modelEntries().forEach((m) => found.set(m.name, m));
      await sleep(200);
      add();
      const sub = menuItems().find((el) => /^more models/.test(itemText(el)));
      if (sub) {
        const before = found.size;
        const grew = async (ms) => {
          for (let t = 0; t < ms && found.size === before; t += 100) { await sleep(100); add(); }
          return found.size > before;
        };
        hover(sub);
        sub.click();
        if (!(await grew(1200))) {
          sub.focus();
          sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
          await grew(800);
        }
        await sleep(300); // the list can fill in over a moment
        add();
      }
      await closeMenu();
      return [...found.values()];
    },

    // Opens a new, empty chat in this tab. Returns true once its input box is ready.
    async openNewChat() {
      const onNew = () => /^\/new\/?$/.test(location.pathname);
      if (!onNew()) {
        const link = all(SEL.newChat)[0]; // may be hidden in a collapsed sidebar; click() still works
        if (!link) return false;
        link.click();
      }
      for (let t = 0; t < 6000; t += 100) {
        await sleep(100);
        if (onNew() && first(SEL.editor)) {
          await sleep(400); // let the new composer and model picker finish rendering
          return true;
        }
      }
      return false;
    },

    // Clicks send, only if the editor holds exactly `expectedText`.
    async send(expectedText) {
      if (!sameText(this.getPrompt(), expectedText)) return false;
      for (let i = 0; i < 20; i++) {
        const btn = first(SEL.sendButton);
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        await sleep(100);
      }
      return false;
    },

    // Counts only (turns, ~tokens) and the chat title; message text never leaves this page.
    async getThreadStats() {
      const counts = (await countFromApi().catch(() => null)) ?? countFromPage();
      return { ...counts, title: chatTitle() };
    },

    // True while Claude is still writing a reply (usage is re-read once it finishes).
    isStreaming() {
      return !!document.querySelector(SEL.streaming);
    },

    // ---- Usage (SPEC §2.4) ----
    // Where the user can see (and we can read) their usage.
    usageUrl: 'https://claude.ai/settings/usage',

    isUsagePage() {
      return /settings\/usage/.test(location.pathname + location.hash);
    },

    // Settings opens as a window over the chat, with "#settings/<tab>" in the address (2026-10-27).
    isSettingsOpen() {
      return /^#settings\b/.test(location.hash) || location.pathname.startsWith('/settings');
    },

    // On page load: session/weekly limits (Pro/Max) from the same JSON claude.ai's usage page loads.
    // Returns { meters: [...] } or null (e.g. Enterprise spend limits, which come from readUsagePage).
    async getUsage() {
      return usageFromApi().catch(() => null);
    },

    // On Settings → Usage: the numbers as shown on the page.
    readUsagePage() {
      return usageFromText(document.body.innerText);
    },
  };

  // Tab title is "<chat title> - Claude"; new chats are "Claude" or "New chat - Claude".
  function chatTitle() {
    const title = document.title.replace(/\s*[-–|]\s*Claude\s*$/, '').trim();
    return !title || /^(claude|new chat)$/i.test(title) ? null : title;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const sameText = (a, b) => norm(a) === norm(b);
  const itemText = (el) => norm(el.innerText).toLowerCase();

  // Menu libraries differ on which event opens or selects: some act on pointerdown, some on click, and
  // a full down+up+click can open then immediately close (seen 2026-10-24). So send one gesture at a
  // time and stop as soon as it worked.
  const PTR = { bubbles: true, cancelable: true, button: 0, buttons: 1, pointerType: 'mouse', isPrimary: true };
  const down = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', PTR));
    el.dispatchEvent(new MouseEvent('mousedown', PTR));
  };
  const up = (el) => {
    el.dispatchEvent(new PointerEvent('pointerup', { ...PTR, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...PTR, buttons: 0 }));
  };
  function hover(el) {
    const opts = { bubbles: true, pointerType: 'mouse' };
    el.dispatchEvent(new PointerEvent('pointerover', opts));
    el.dispatchEvent(new PointerEvent('pointerenter', opts));
    el.dispatchEvent(new PointerEvent('pointermove', opts));
    el.dispatchEvent(new MouseEvent('mousemove', opts));
  }
  // Selects a menu entry: hover + click first; if the menu is still open, try press + release.
  async function press(el) {
    hover(el);
    el.click();
    await sleep(150);
    if (el.isConnected && visible(el)) {
      down(el);
      up(el);
      await sleep(150);
    }
  }
  const menuItems = () => [...document.querySelectorAll(SEL.menuItem)].filter(visible);

  async function waitItems(ms) {
    for (let t = 0; t < ms; t += 50) {
      const items = menuItems();
      if (items.length) return items;
      await sleep(50);
    }
    return [];
  }

  // The menu fills in over a moment (the "More models" list can arrive after the first entries),
  // so keep looking for the wanted entry rather than searching the first snapshot only.
  async function findItem(match, ms = 1500) {
    for (let t = 0; t <= ms; t += 100) {
      const item = match(menuItems());
      if (item) return item;
      await sleep(100);
    }
    return null;
  }

  // Finds an entry; if it's not shown, opens the submenu whose trigger matches `subTrigger`
  // (wide windows: "Effort ›" / "More models ›"; narrow windows show everything inline).
  async function pick(match, subTrigger) {
    let item = await findItem(match, 500);
    const sub = !item && menuItems().find((el) => subTrigger.test(itemText(el)));
    if (sub) {
      hover(sub);
      sub.click();
      item = await findItem(match, 1200);
      if (!item) {
        sub.focus();
        sub.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        item = await findItem(match, 800);
      }
    }
    return item;
  }

  // A model entry starts with a name and version ("Sonnet 5.5", "Haiku 4.5"), then the site's description
  // ("Most efficient for everyday tasks"), on the next line or after a separator. Effort, "More models"
  // and other menus' entries have no version number. Only read while the menu is the model menu.
  const MODEL_NAME = /^(?:Claude\s+)?([A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?) (\d+(?:\.\d+)*)\b\s*[|·:–-]?\s*(.*)$/;
  function modelEntries() {
    const items = menuItems();
    const out = [];
    for (const el of items) {
      const lines = el.innerText.split('\n').map((s) => s.trim()).filter(Boolean);
      const m = lines[0]?.match(MODEL_NAME);
      if (!m) continue;
      // Drop icon glyphs (private-use characters) and check marks the menu renders as text.
      const description = norm([m[3], ...lines.slice(1)].join(' ').replace(/[\p{Co}✓✔�]/gu, '')).slice(0, 160);
      out.push({ name: `${m[1]} ${m[2]}`, description });
    }
    const label = (TM.siteReader.getModelLabel() ?? '').toLowerCase();
    const isModelMenu = out.some((m) => label.includes(m.name.toLowerCase())) ||
      items.some((el) => /^(more models|effort)\b/.test(itemText(el)));
    return isModelMenu ? out : [];
  }

  async function openMenu() {
    if (menuItems().length) return menuItems();
    const btn = modelButton();
    if (!btn) return [];
    // 1) press only (pointerdown-driven menus), 2) release, 3) a plain click (click-driven menus).
    for (const gesture of [() => down(btn), () => up(btn), () => btn.click()]) {
      gesture();
      const items = await waitItems(400);
      if (items.length) return items;
    }
    return [];
  }
  async function closeMenu() {
    for (let i = 0; i < 3 && first(SEL.menu); i++) {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(150);
    }
    await sleep(150); // let the picker label update
  }

  // claude.ai only renders messages near the scroll position (virtualised list), so the page
  // under-counts long chats. The full conversation comes from the same JSON claude.ai's own UI
  // loads, fetched with the user's existing session (same origin, no extra permissions).
  const chatId = () => location.pathname.match(/\/chat\/([0-9a-f-]{36})/)?.[1] ?? null;
  const orgId = () => document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/)?.[1] ?? null;

  // The visible branch of the current chat, oldest message first, or null if it can't be loaded.
  async function fetchBranch() {
    const conv = chatId();
    const org = orgId();
    if (!conv || !org) return null;
    const res = await fetch(
      `/api/organizations/${org}/chat_conversations/${conv}?tree=True&rendering_mode=messages&render_all_tools=true`,
      { credentials: 'include' },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const msgs = data.chat_messages;
    if (!Array.isArray(msgs)) return null;

    // With tree=True, edited prompts leave old branches; walk back from the current leaf to keep only the visible one.
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    let branch = msgs;
    if (byId.has(data.current_leaf_message_uuid)) {
      branch = [];
      for (let m = byId.get(data.current_leaf_message_uuid); m; m = byId.get(m.parent_message_uuid)) branch.unshift(m);
    }
    return { branch };
  }

  async function countFromApi() {
    if (!chatId()) return { turns: 0, approx_tokens: 0, source: 'api' }; // new chat
    const got = await fetchBranch();
    if (!got) return null;
    const { branch } = got;
    const chars = branch.reduce((n, m) => n + messageChars(m), 0);
    return {
      turns: branch.filter((m) => m.sender === 'human').length,
      approx_tokens: Math.round(chars / 4),
      source: 'api',
    };
  }

  // Text the model re-reads each turn: message text, tool calls/results and attached file text (not thinking).
  function messageChars(m) {
    const blocks = Array.isArray(m.content) && m.content.length ? m.content : [{ type: 'text', text: m.text ?? '' }];
    let n = 0;
    for (const b of blocks) {
      if (b.type === 'thinking') continue;
      if (typeof b.text === 'string') n += b.text.length;
      if (b.input) n += JSON.stringify(b.input).length;
      if (Array.isArray(b.content)) n += JSON.stringify(b.content).length;
    }
    for (const a of m.attachments ?? []) n += (a.extracted_content ?? '').length;
    return n;
  }

  // ---- Usage ----
  // A reading is { meters: [{ id, label, usedPct, used?, limit?, currency?, resetsAt (ISO), period }] },
  // period: 'session' (5 h) | 'week' | 'month'. Only these numbers leave the page.

  // GET /api/organizations/<org>/usage, the same JSON claude.ai's Settings → Usage loads.
  // Pro/Max limits: { five_hour: { utilization: 23, resets_at: "…" }, seven_day: {…}, seven_day_opus: {…} }
  // (shape not yet seen on a Pro/Max account).
  // Enterprise spend limit (seen 2026-10-27, five_hour etc. null):
  //   spend: { used: { amount_minor: 12055, currency: "USD", exponent: 2 }, limit: { amount_minor: 50000, … }, enabled: true }
  //   extra_usage: { monthly_limit: 50000, used_credits: 12055, utilization: 24.11, currency: "USD", decimal_places: 2 }
  // No reset date in the response: the page shows "Resets Sun, Nov 1, 5:30 AM GMT+5:30", i.e. 00:00 UTC on
  // the 1st, and its daily chart is "Dates in UTC", so the period is taken as the calendar month in UTC.
  const API_METERS = {
    five_hour: { id: 'session', label: 'Session', period: 'session' },
    seven_day: { id: 'weekly', label: 'Weekly', period: 'week' },
    seven_day_opus: { id: 'weekly_opus', label: 'Weekly (Opus)', period: 'week' },
  };
  async function usageFromApi() {
    const org = orgId();
    if (!org) return null;
    const res = await fetch(`/api/organizations/${org}/usage`, { credentials: 'include' });
    if (!res.ok) return null;
    const data = await res.json();
    const meters = Object.entries(API_METERS)
      .filter(([k]) => typeof data?.[k]?.utilization === 'number' && data[k].resets_at)
      .map(([k, m]) => ({ ...m, usedPct: data[k].utilization, resetsAt: new Date(data[k].resets_at).toISOString() }));
    // A spend limit is the plan's own limit only when there are no session/weekly limits; on Pro/Max the
    // same fields describe paid extra usage, which isn't allowance to "use up".
    const spend = meters.length ? null : spendMeter(data);
    if (spend) meters.push(spend);
    return meters.length ? { meters, source: 'api' } : null;
  }

  const SYMBOL = { USD: '$', EUR: '€', GBP: '£', INR: '₹' };
  function spendMeter(data) {
    const s = data?.spend;
    const x = data?.extra_usage;
    let used;
    let limit;
    let currency;
    if (s?.enabled && s.used && s.limit?.amount_minor) {
      used = s.used.amount_minor / 10 ** (s.used.exponent ?? 2);
      limit = s.limit.amount_minor / 10 ** (s.limit.exponent ?? 2);
      currency = s.limit.currency ?? s.used.currency;
    } else if (x?.is_enabled && x.monthly_limit) {
      used = x.used_credits / 10 ** (x.decimal_places ?? 2);
      limit = x.monthly_limit / 10 ** (x.decimal_places ?? 2);
      currency = x.currency;
    } else {
      return null;
    }
    const now = new Date();
    const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
    return {
      id: 'spend', label: 'Monthly spend', usedPct: (100 * used) / limit, used, limit,
      currency: SYMBOL[currency] ?? `${currency ?? ''} `, resetsAt, period: 'month',
    };
  }

  // Enterprise, 2026-10-21 text on Settings → Usage:
  //   "$76.38 of $500.00 spent · Spend limit · Resets Sun, Nov 1, 5:30 AM GMT+5:30 · 15% used"
  function usageFromText(text) {
    const spend = text.match(/([$€£₹])\s?([\d,]+(?:\.\d+)?)\s+of\s+[$€£₹]?\s?([\d,]+(?:\.\d+)?)\s+spent/i);
    if (!spend) return null;
    const num = (s) => Number(s.replace(/,/g, ''));
    const used = num(spend[2]);
    const limit = num(spend[3]);
    const resetsAt = parseResetDate(text.slice(spend.index, spend.index + 300).match(/Resets\s+([^·\n]+)/i)?.[1]);
    if (!limit || !resetsAt) return null;
    return { meters: [{ id: 'spend', label: 'Monthly spend', usedPct: (100 * used) / limit, used, limit, currency: spend[1], resetsAt, period: 'month' }], source: 'page' };
  }

  // "Sun, Nov 1, 5:30 AM GMT+5:30" -> ISO string, in the browser's time zone. No year shown: the next such date.
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseResetDate(s) {
    const m = s?.match(/\b([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?(?:,?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*(AM|PM)?)?/i);
    const month = MONTHS.indexOf(m?.[1].toLowerCase());
    if (month < 0) return null;
    let hour = Number(m[4] ?? 0);
    if (m[6]) hour = (hour % 12) + (/pm/i.test(m[6]) ? 12 : 0);
    const now = new Date();
    const at = (year) => new Date(year, month, Number(m[2]), hour, Number(m[5] ?? 0));
    let date = at(Number(m[3] ?? now.getFullYear()));
    if (!m[3] && date < now - 864e5) date = at(now.getFullYear() + 1);
    return date.toISOString();
  }

  // Fallback: count what is currently rendered (low for long chats).
  function countFromPage() {
    const users = all(SEL.userMessage);
    const replies = all(SEL.assistantMessage);
    const chars = [...users, ...replies].reduce((n, el) => n + el.innerText.length, 0);
    return { turns: users.length, approx_tokens: Math.round(chars / 4), source: 'page' };
  }
})();
