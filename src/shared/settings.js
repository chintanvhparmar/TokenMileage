// User settings live in chrome.storage.local (not .sync), so the API key never leaves this device.

export const DEFAULT_SETTINGS = {
  apiKey: '',
  baseUrl: '',         // empty = use config/tokenfactory.json
  tavilyKey: '',       // Tavily API key for model research (optional; without it, family defaults are used)
  planType: 'flat',    // 'flat' (session/weekly limits) | 'usage' (pay per use) | 'spend' (monthly $ limit, e.g. Enterprise)
  fixedFee: false,     // 'spend' only: the company pays the full limit even if it isn't used
  sites: { claude: true, chatgpt: true },
  // Usage alerts (SPEC §2.4). Pace = share of the allowance used / share of the period gone.
  alerts: {
    nearLimitPct: 90,  // "near limit" once this much of the allowance is used
    slowDownPace: 110, // "slow down" when on pace to use more than this % of the allowance by the reset
    useItPace: 75,     // "use it" when on pace to use less than this % (only if unused allowance is lost)
    hideMinutes: 5,    // after the user closes the card with ×, hide the same advice this long (0 = every page load)
  },
};

// True when allowance left at reset is wasted, so "use it" nudges make sense (SPEC §2.4).
export function unusedAllowanceLost(settings) {
  if (settings.planType === 'spend') return settings.fixedFee;
  return settings.planType === 'flat';
}

export async function getSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    sites: { ...DEFAULT_SETTINGS.sites, ...settings.sites },
    alerts: { ...DEFAULT_SETTINGS.alerts, ...settings.alerts },
  };
}

export async function saveSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}
