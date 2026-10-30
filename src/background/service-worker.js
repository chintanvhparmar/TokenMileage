// Service worker: routes messages from content scripts and the options page.
import { evaluate } from './evaluate.js';
import { testConnection } from './tokenFactory.js';
import { getUsageSummary } from './usageLog.js';
import { usageCheck, usageClosed, latestAdvice } from './usage.js';
import { getCatalogue, modelScanDue, modelsSeen } from './models.js';
import { researchModel, researchPending } from './research.js';
import { testTavily } from './tavily.js';
import { getMileage, logApply } from './outcomes.js';

const handlers = {
  'tm/evaluate': (payload) => evaluate(payload),
  'tm/usageCheck': (payload) => usageCheck(payload),
  'tm/usageClosed': (payload) => usageClosed(payload),
  'tm/usageAdvice': () => latestAdvice(),
  'tm/testConnection': () => testConnection(),
  'tm/usageSummary': () => getUsageSummary(),
  'tm/openOptions': () => chrome.runtime.openOptionsPage(), // content scripts can't open it themselves
  // Models in the site's picker, and their research (Nemotron + Tavily), which runs in the background.
  'tm/modelScanDue': (payload) => modelScanDue(payload),
  'tm/modelsSeen': async (payload) => {
    const res = await modelsSeen(payload);
    researchPending(payload.site); // new or stale models only; not awaited
    return res;
  },
  'tm/models': ({ site }) => getCatalogue(site),
  'tm/researchModel': (payload) => researchModel(payload),
  'tm/researchAll': ({ site }) => { researchPending(site, { force: true }); return true; },
  'tm/testTavily': () => testTavily(),
  // Mileage: outcomes of confirmed Apply / Apply & send clicks (ids and numbers only).
  'tm/outcome': (payload) => logApply(payload),
  'tm/mileage': (payload) => getMileage(payload),
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const handler = handlers[msg?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(() => handler(msg.payload ?? {}))
    .then(
      (data) => sendResponse({ ok: true, data }),
      (err) => sendResponse({ ok: false, error: err.message, code: err.code ?? 'error' }),
    );
  return true; // keeps the channel open for the async sendResponse
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.runtime.openOptionsPage();
});

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/dashboard.html') }));
