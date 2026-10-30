// Content-script entry point. Loaded after the site reader (TM.siteReader) and overlay (TM.createOverlay).
(async () => {
  const reader = globalThis.TM?.siteReader;
  if (!reader) return;

  async function send(type, payload) {
    try {
      return await chrome.runtime.sendMessage({ type, payload });
    } catch {
      // Happens after the extension is reloaded: this old content script is orphaned.
      return { ok: false, error: 'TokenMileage was updated. Reload this page.', code: 'stale' };
    }
  }

  const overlay = TM.createOverlay({
    reader,
    onEvaluate: async (prompt) => {
      await scanModelsIfDue();
      return send('tm/evaluate', {
        site: reader.site,
        prompt,
        modelLabel: reader.getModelLabel(),
        thread: await reader.getThreadStats(),
        usage: null, // the background adds the latest usage reading
      });
    },
    onApply,
    onOpenOptions: () => send('tm/openOptions'),
    onUsageClosed: (status) => send('tm/usageClosed', { status }),  });

  // Card buttons "Apply" / "Apply & send". Each step is checked; nothing is sent unless every
  // requested change is confirmed on the page. Returns { ok, message, navigated }.
  async function onApply(args) {
    const res = await applySteps(args);
    // Mileage: count only what was confirmed on the page (ids and numbers, never the prompt).
    if (res.ok && args.outcome) send('tm/outcome', { site: reader.site, ...args.outcome, newChat: !!args.newChat, sent: !!args.andSend });
    return { ...res, navigated: !!args.newChat };
  }

  async function applySteps({ prompt, model, effort, andSend, newChat }) {
    // newChat: move to a fresh chat first. Take the text now: the current draft is gone after leaving.
    if (newChat) {
      prompt = prompt ?? reader.getPrompt();
      if (!(await reader.openNewChat())) {
        return { ok: false, message: `Couldn’t open a new chat${andSend ? ', so nothing was sent' : ''}. Click “New chat” yourself.` };
      }
    }
    // model: the recommended catalogue entry when the model or the effort must change (else null).
    if (model) {
      const res = await reader.selectModel(model, effort);
      if (!res.ok) {
        const want = [model.label, effort && `${effort} effort`].filter(Boolean).join(' · ') + (res.step ? ` (${res.step})` : '');
        if (andSend) return { ok: false, message: `Couldn’t switch to ${want} automatically, so nothing was sent. Pick it in the model menu.` };
        if (prompt && !(await reader.setPrompt(prompt))) return { ok: false, message: 'Couldn’t switch the model or fill in the prompt.' };
        return { ok: false, message: `Prompt filled in. Couldn’t switch to ${want} automatically: pick it in the model menu.` };
      }
    }
    if (prompt && !(await reader.setPrompt(prompt))) {
      return { ok: false, message: 'Couldn’t fill in the revised prompt. Copy it from the card instead.' };
    }
    if (!andSend) return { ok: true, message: `Applied${newChat ? ' in a new chat' : ''}. Review it and press send.` };
    const sent = await reader.send(prompt ?? reader.getPrompt());
    return sent ? { ok: true, message: 'Sent.' } : { ok: false, message: 'Applied, but couldn’t press send. Press it yourself.' };
  }

  // ---- Models the user can pick: read from the site's own picker (names + descriptions only) ----
  // At most once a day, on an Evaluate click, open the picker (and "More models") to read the full list.
  async function scanModelsIfDue() {
    const due = await send('tm/modelScanDue', { site: reader.site });
    if (!due?.ok || !due.data) return;
    const models = await reader.scanModels();
    if (models?.length) await send('tm/modelsSeen', { site: reader.site, models, full: true });
  }
  // Whenever the user opens the model menu, note what it shows (new models appear here first).
  let menuSeen = '';
  setInterval(() => {
    if (!reader.isMenuOpen()) { menuSeen = ''; return; }
    const models = reader.readModelMenu();
    const key = models.map((m) => m.name).join('|');
    if (!models.length || key === menuSeen) return;
    menuSeen = key;
    send('tm/modelsSeen', { site: reader.site, models, full: false });
  }, 1000);

  const enabled = (settings) => settings?.sites?.[reader.site] !== false;
  const apply = (on) => (on ? overlay.mount() : overlay.unmount());

  let { settings } = await chrome.storage.local.get('settings');
  apply(enabled(settings));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = changes.settings.newValue;
    apply(enabled(settings));
  });

  // ---- Usage check (SPEC §2.4): on page load, advise "use it" / "slow down" from the usage numbers ----
  // onlyIfChanged: a refresh during the session updates the pill and badge, and pops the card up only
  // when the advice changes (e.g. on track -> slow down).
  let lastStatus = null;
  async function checkUsage(reading, quiet = false, onlyIfChanged = false) {
    if (!enabled(settings)) return;
    const res = await send('tm/usageCheck', { site: reader.site, reading, quiet });
    if (!res?.ok) {
      console.info('[TokenMileage] usage check: error', res?.error);
      return;
    }
    const { advice } = res.data;
    const show = res.data.show && (!onlyIfChanged || advice.status !== lastStatus);
    // Status only (no usage numbers), to diagnose "nothing showed" from the page console.
    console.info('[TokenMileage] usage check:', reading ? `read (${reading.source})` : 'no fresh reading',
      `→ ${advice.status}${quiet ? ', badge only' : show ? ', shown' : onlyIfChanged ? ', pill updated' : ', hidden (closed recently)'}`);
    if (!quiet) lastStatus = advice.status;
    overlay.setUsage(advice, reader.usageUrl);
    if (show) overlay.showUsage(advice, reader.usageUrl);
  }

  // Re-read during the session: after each reply (spend updates a moment later), when the tab comes back
  // into view, and on moving to another chat. One small request, at most every 15 s.
  let lastRefresh = Date.now();
  async function refreshUsage(minGapMs = 15000) {
    if (Date.now() - lastRefresh < minGapMs || !reader.getComposer() || reader.isSettingsOpen()) return;
    lastRefresh = Date.now();
    checkUsage(await reader.getUsage(), false, true);
  }
  let wasStreaming = false;
  let chatPath = location.pathname;
  setInterval(() => {
    const streaming = reader.isStreaming();
    if (wasStreaming && !streaming) setTimeout(() => refreshUsage(0), 5000);
    wasStreaming = streaming;
    if (location.pathname !== chatPath) {
      chatPath = location.pathname;
      refreshUsage();
    }
  }, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refreshUsage(60000);
  });
  // A reading from the site's API if it has one (Pro/Max); otherwise the background re-checks the
  // last saved reading against today's date. The card anchors to the input box, which renders a moment
  // after load; pages without one (settings) only update the badge, so the advice isn't "used up" there.
  const reading = await reader.getUsage();
  for (let t = 0; t < 10000 && !reader.getComposer(); t += 250) await new Promise((r) => setTimeout(r, 250));
  checkUsage(reading, !reader.getComposer());

  // The usage page itself shows the numbers (Enterprise spend limits): read them whenever it's open.
  // Badge only there (no composer to anchor a card to); the advice shows on the next chat page load.
  let usageRead = false;
  setInterval(() => {
    if (!reader.isUsagePage()) { usageRead = false; return; }
    if (usageRead) return;
    const reading = reader.readUsagePage();
    if (reading) {
      usageRead = true;
      checkUsage(reading, true);
    }
  }, 1000);
})();
