// Nebius Token Factory client (OpenAI-compatible /v1/chat/completions).
// Never logs prompt text; only token counts go to the usage log.
import { getTokenFactoryConfig, modelFor } from '../shared/config.js';
import { logUsage } from './usageLog.js';

export class TokenFactoryError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code; // 'no_key' | 'auth' | 'http' | 'network' | 'invalid_json'
  }
}

// The timeout covers the whole exchange, including reading a streamed body.
async function request(cfg, path, init = {}, parse = (res) => res.json()) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
  try {
    const res = await fetch(`${cfg.baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      const auth = res.status === 401 || res.status === 403;
      throw new TokenFactoryError(
        auth ? 'Nebius API key was rejected' : `Token Factory returned HTTP ${res.status} ${detail}`,
        auth ? 'auth' : 'http',
      );
    }
    return await parse(res);
  } catch (e) {
    if (e instanceof TokenFactoryError) throw e;
    throw new TokenFactoryError(
      e.name === 'AbortError' ? 'Token Factory timed out' : 'Could not reach Token Factory (check the base URL)',
      'network',
    );
  } finally {
    clearTimeout(timer);
  }
}

// Reads an OpenAI-style server-sent-events stream: "data: {chunk}" lines, ending with "data: [DONE]".
// Only the answer is kept; reasoning deltas are just counted (to check the reasoning-off switch works).
async function readSse(res, t0) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let content = '';
  let reasoningChars = 0;
  let ttftMs = null;
  let usage;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.startsWith('data:') ? line.slice(5).trim() : '';
      if (!data || data === '[DONE]') continue;
      let chunk;
      try { chunk = JSON.parse(data); } catch { continue; }
      const delta = chunk.choices?.[0]?.delta;
      const text = delta?.content ?? '';
      const thinking = delta?.reasoning_content ?? delta?.reasoning ?? '';
      if (ttftMs == null && (text || thinking)) ttftMs = Math.round(performance.now() - t0);
      content += text;
      reasoningChars += thinking.length;
      if (chunk.usage) usage = chunk.usage;
    }
  }
  return { content, usage, reasoningChars, ttftMs };
}

// cfg.responseFormat (if set) overrides jsonMode, e.g. { type: 'json_schema', ... } for bench probes.
async function chatCompletion(cfg, { model, messages, maxTokens }) {
  const body = {
    model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
    ...cfg.reasoningOff?.extraBody,
  };
  if (cfg.responseFormat) body.response_format = cfg.responseFormat;
  else if (cfg.jsonMode) body.response_format = { type: 'json_object' };
  if (cfg.stream) {
    body.stream = true;
    body.stream_options = { include_usage: true }; // final chunk carries token counts
  }
  const init = { method: 'POST', body: JSON.stringify(body) };
  const t0 = performance.now();

  let out;
  if (cfg.stream) {
    out = await request(cfg, '/chat/completions', init, (res) => readSse(res, t0));
  } else {
    const data = await request(cfg, '/chat/completions', init);
    const msg = data.choices?.[0]?.message;
    out = {
      content: msg?.content ?? '',
      usage: data.usage,
      reasoningChars: (msg?.reasoning_content ?? msg?.reasoning ?? '').length,
      ttftMs: null,
    };
  }
  return { ...out, ms: Math.round(performance.now() - t0) };
}

// Tolerates <think> blocks, ```json fences and stray text around the object.
export function parseJsonLoose(text) {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { ok: false, error: 'no JSON object found' };
  try {
    return { ok: true, value: JSON.parse(cleaned.slice(start, end + 1)) };
  } catch {
    return { ok: false, error: 'malformed JSON' };
  }
}


// The feature's model from config, or a specific model id (bench comparisons).
function pickModel(cfg, feature, modelId) {
  if (!modelId) return modelFor(cfg, feature);
  return Object.values(cfg.models).find((m) => m.id === modelId) ?? { id: modelId, name: modelId, pricePerMTokens: null };
}

// Optional per-run totals (bench and research entries): calls, tokens, estimated cost, time.
function addStats(stats, usage, price, ms) {
  if (!stats) return;
  const p = usage?.prompt_tokens ?? 0;
  const c = usage?.completion_tokens ?? 0;
  stats.nemotron_calls = (stats.nemotron_calls ?? 0) + 1;
  stats.prompt_tokens = (stats.prompt_tokens ?? 0) + p;
  stats.completion_tokens = (stats.completion_tokens ?? 0) + c;
  stats.nemotron_ms = (stats.nemotron_ms ?? 0) + ms;
  if (price) stats.est_cost_usd = (stats.est_cost_usd ?? 0) + (p * price.input + c * price.output) / 1e6;
}

/**
 * Calls the feature's Nemotron model with reasoning off and returns validated JSON.
 * On invalid output, retries once with the validation error; then throws 'invalid_json'.
 */
export async function nemotronJson({ feature, system, user, validate, maxTokens = 400, modelId, stats }) {
  const cfg = await getTokenFactoryConfig();
  if (!cfg.apiKey) throw new TokenFactoryError('Add your Nebius API key in TokenMileage options', 'no_key');
  const model = pickModel(cfg, feature, modelId);

  const prefix = cfg.reasoningOff?.systemPrefix;
  const messages = [
    { role: 'system', content: prefix ? `${prefix}\n${system}` : system },
    { role: 'user', content: user },
  ];

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { content, usage, ms } = await chatCompletion(cfg, { model: model.id, messages, maxTokens });
    await logUsage({ feature, model: model.id, attempt, usage, price: model.pricePerMTokens });
    addStats(stats, usage, model.pricePerMTokens, ms);

    const parsed = parseJsonLoose(content);
    const result = parsed.ok ? validate(parsed.value) : parsed;
    if (result.ok) return result.value;

    lastError = result.error;
    messages.push(
      { role: 'assistant', content },
      { role: 'user', content: `Invalid reply: ${result.error}. Reply again with ONLY the JSON object, matching the schema exactly.` },
    );
  }
  throw new TokenFactoryError(`Nemotron returned invalid JSON twice (${lastError})`, 'invalid_json');
}

/**
 * One agent step: the feature's Nemotron with OpenAI-style tools (non-streaming, reasoning off).
 * Returns the assistant message ({ content, tool_calls? }). Token counts go to the usage log.
 */
export async function nemotronChat({ feature, messages, tools, toolChoice, maxTokens = 800, modelId, stats }) {
  const cfg = await getTokenFactoryConfig();
  if (!cfg.apiKey) throw new TokenFactoryError('Add your Nebius API key in TokenMileage options', 'no_key');
  const model = pickModel(cfg, feature, modelId);
  const body = { model: model.id, messages, temperature: 0, max_tokens: maxTokens, ...cfg.reasoningOff?.extraBody };
  if (tools) {
    body.tools = tools;
    body.tool_choice = toolChoice ?? 'auto';
  }
  const t0 = performance.now();
  const data = await request(cfg, '/chat/completions', { method: 'POST', body: JSON.stringify(body) });
  await logUsage({ feature, model: model.id, attempt: 1, usage: data.usage, price: model.pricePerMTokens });
  addStats(stats, data.usage, model.pricePerMTokens, Math.round(performance.now() - t0));
  return data.choices?.[0]?.message ?? {};
}

/**
 * One raw call for bench/: any model, with config overrides (reasoningOff, jsonMode, responseFormat,
 * stream, timeoutMs, baseUrl). Returns content, parsed JSON, usage, ms, ttftMs, reasoningChars.
 * No retry and no validation - the benchmark scores the raw output.
 */
export async function rawChat(overrides, { model, system, user, maxTokens = 600 }) {
  const cfg = { ...(await getTokenFactoryConfig()), ...overrides };
  if (!cfg.apiKey) throw new TokenFactoryError('Add your Nebius API key in TokenMileage options', 'no_key');
  const prefix = cfg.reasoningOff?.systemPrefix;
  const messages = [
    { role: 'system', content: prefix ? `${prefix}\n${system}` : system },
    { role: 'user', content: user },
  ];
  const out = await chatCompletion(cfg, { model, messages, maxTokens });
  const price = Object.values(cfg.models).find((m) => m.id === model)?.pricePerMTokens ?? null;
  await logUsage({ feature: 'bench', model, attempt: 1, usage: out.usage, price });
  return { ...out, parsed: parseJsonLoose(out.content) };
}

// Options-page "Test connection": lists models (costs no tokens) and checks every model a feature uses exists.
export async function testConnection() {
  const cfg = await getTokenFactoryConfig();
  if (!cfg.apiKey) throw new TokenFactoryError('Enter an API key first', 'no_key');
  const data = await request(cfg, '/models');
  const ids = (data.data ?? []).map((m) => m.id);
  const used = [...new Set([modelFor(cfg, 'default').id, ...Object.keys(cfg.taskModels ?? {}).map((f) => modelFor(cfg, f).id)])];
  return {
    baseUrl: cfg.baseUrl,
    modelCount: ids.length,
    usedModels: used,
    missing: used.filter((id) => !ids.includes(id)),
    nemotronIds: ids.filter((id) => /nemotron/i.test(id)),
  };
}
