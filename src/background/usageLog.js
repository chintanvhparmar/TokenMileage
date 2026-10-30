// Per-call usage log (counts only - never prompt, response or page text), for real cost numbers in the README.
// Token Factory calls: token counts. Tavily calls (service: 'tavily'): credits.
const KEY = 'usageLog';
const MAX_ENTRIES = 2000;

export async function logUsage({ feature, model, attempt, usage, price, service, endpoint, credits }) {
  let entry;
  if (service === 'tavily') {
    entry = { ts: Date.now(), feature, service, endpoint, credits };
  } else {
    const promptTokens = usage?.prompt_tokens ?? null;
    const completionTokens = usage?.completion_tokens ?? null;
    entry = {
      ts: Date.now(),
      feature,
      model,
      attempt,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      est_cost_usd:
        price && promptTokens != null && completionTokens != null
          ? (promptTokens * price.input + completionTokens * price.output) / 1e6
          : null,
    };
  }
  const { [KEY]: log = [] } = await chrome.storage.local.get(KEY);
  log.push(entry);
  await chrome.storage.local.set({ [KEY]: log.slice(-MAX_ENTRIES) });
}

export async function getUsageSummary() {
  const { [KEY]: log = [] } = await chrome.storage.local.get(KEY);
  return log.reduce(
    (s, e) => e.service === 'tavily'
      ? { ...s, tavily_calls: s.tavily_calls + 1, tavily_credits: s.tavily_credits + (e.credits ?? 0) }
      : {
        ...s,
        calls: s.calls + 1,
        prompt_tokens: s.prompt_tokens + (e.prompt_tokens ?? 0),
        completion_tokens: s.completion_tokens + (e.completion_tokens ?? 0),
        est_cost_usd: s.est_cost_usd + (e.est_cost_usd ?? 0),
      },
    { calls: 0, prompt_tokens: 0, completion_tokens: 0, est_cost_usd: 0, tavily_calls: 0, tavily_credits: 0 },
  );
}
