// Usage alerts (SPEC §2.4): keeps the latest usage reading, works out the advice, sets the toolbar badge
// and decides whether the page should show the advice now. Readings are numbers only (no chat text).
import { getSettings } from '../shared/settings.js';
import { adviseUsage } from '../shared/pacing.js';

const READING = 'usageReading';
const CLOSED = 'usageAdviceClosed';
const BADGE_COLOR = { limit: '#b42318', slow: '#b42318', use: '#6d28d9', ok: '#1e7b3c', unknown: '#6f6b63' };

export async function latestAdvice() {
  const [settings, { [READING]: reading }] = await Promise.all([getSettings(), chrome.storage.local.get(READING)]);
  return adviseUsage(reading, settings);
}

// reading: a fresh reading from the page, or null to re-check the saved one. quiet: update the badge only.
export async function usageCheck({ site, reading, quiet }) {
  if (reading) await chrome.storage.local.set({ [READING]: { ...reading, site, readAt: new Date().toISOString() } });
  const [advice, settings, { [CLOSED]: closed }] = await Promise.all([latestAdvice(), getSettings(), chrome.storage.local.get(CLOSED)]);
  await setBadge(advice);
  if (quiet) return { advice, show: false };
  // Shown on every page load, except for hideMinutes after the user closed the same advice with ×.
  // Different advice (e.g. on track -> slow down) shows straight away.
  const hidden = closed?.status === advice.status && Date.now() - closed.at < settings.alerts.hideMinutes * 60000;
  return { advice, show: !hidden };
}

// The user closed the usage card with ×.
export async function usageClosed({ status }) {
  await chrome.storage.local.set({ [CLOSED]: { status, at: Date.now() } });
}

async function setBadge(advice) {
  await chrome.action.setBadgeText({ text: advice.badge });
  if (advice.badge) await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOR[advice.status] });
  await chrome.action.setTitle({ title: `TokenMileage · ${advice.title}\n${advice.text}` });
}
