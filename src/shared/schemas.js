// JSON contracts for Lightning calls (SPEC.md §5). Validators return { ok, value } or { ok: false, error }.

export const EVALUATE_ENUMS = {
  complexity: ['simple', 'standard', 'complex'],
  task_type: ['reformat', 'summarise', 'code', 'analysis', 'writing', 'research', 'other'],
  effort: ['low', 'medium', 'high'],
  workspace: ['chat', 'project'],
  output: ['chat', 'artifact'],
  saving: ['none', 'low', 'medium', 'high'],
};

// Shown to the model verbatim.
export const EVALUATE_SCHEMA_TEXT = `{
  "complexity": "simple | standard | complex",
  "task_type": "reformat | summarise | code | analysis | writing | research | other",
  "recommend": {
    "model": "<model id from catalogue>",
    "effort": "low | medium | high",
    "workspace": "chat | project",
    "fresh_chat": false,
    "output": "chat | artifact",
    "tools_needed": false,
    "schedule_candidate": false
  },
  "tips": ["<see the tips rule>"],
  "est_relative_usage_saving": "none | low | medium | high",
  "revised_prompt": "<improved draft, or empty string>"
}`;

// Model research (research.js): facts about one model, each from a page Tavily returned.
export const RESEARCH_SCHEMA_TEXT = `{
  "best_for": ["<2-4 short phrases>"],
  "size_class": "small | medium | large | null",
  "api_price_per_mtok": { "input": <USD number>, "output": <USD number> } or null,
  "context_window_tokens": <integer> or null,
  "released": "YYYY-MM" or null,
  "sources": ["<URL of each page a fact came from>"]
}`;

export function validateResearch(v) {
  if (!isObj(v)) return fail('top level must be a JSON object');
  if (!Array.isArray(v.best_for) || !v.best_for.every((s) => typeof s === 'string')) return fail('best_for must be an array of strings');
  const size = v.size_class ?? null;
  if (size !== null && !['small', 'medium', 'large'].includes(size)) return fail('size_class must be small|medium|large|null');
  const p = v.api_price_per_mtok ?? null;
  const num = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1000;
  if (p !== null && !(isObj(p) && num(p.input) && num(p.output))) return fail('api_price_per_mtok must be {input, output} numbers or null');
  const ctx = v.context_window_tokens ?? null;
  if (ctx !== null && !(Number.isInteger(ctx) && ctx > 0)) return fail('context_window_tokens must be an integer or null');
  const rel = v.released ?? null;
  if (rel !== null && !(typeof rel === 'string' && /^\d{4}(-\d{2})?/.test(rel))) return fail('released must be "YYYY-MM" or null');
  if (!Array.isArray(v.sources) || !v.sources.every((s) => typeof s === 'string')) return fail('sources must be an array of URLs');
  return {
    ok: true,
    value: {
      best_for: v.best_for.map((s) => s.trim().slice(0, 60)).filter(Boolean).slice(0, 4),
      size_class: size,
      api_price_per_mtok: p && { input: p.input, output: p.output },
      context_window_tokens: ctx,
      released: rel && rel.slice(0, 7),
      sources: v.sources.slice(0, 5),
    },
  };
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function fail(error) {
  return { ok: false, error };
}

export function validateEvaluate(v, modelIds) {
  if (!isObj(v)) return fail('top level must be a JSON object');
  const e = EVALUATE_ENUMS;
  if (!e.complexity.includes(v.complexity)) return fail(`complexity must be one of ${e.complexity.join('|')}`);
  if (!e.task_type.includes(v.task_type)) return fail(`task_type must be one of ${e.task_type.join('|')}`);
  if (!e.saving.includes(v.est_relative_usage_saving)) return fail(`est_relative_usage_saving must be one of ${e.saving.join('|')}`);

  const r = v.recommend;
  if (!isObj(r)) return fail('recommend must be an object');
  if (!modelIds.includes(r.model)) return fail(`recommend.model must be one of ${modelIds.join(', ')}`);
  if (!e.effort.includes(r.effort)) return fail(`recommend.effort must be one of ${e.effort.join('|')}`);
  if (!e.workspace.includes(r.workspace)) return fail(`recommend.workspace must be one of ${e.workspace.join('|')}`);
  if (!e.output.includes(r.output)) return fail(`recommend.output must be one of ${e.output.join('|')}`);
  for (const k of ['fresh_chat', 'tools_needed', 'schedule_candidate']) {
    if (typeof r[k] !== 'boolean') return fail(`recommend.${k} must be true or false`);
  }

  if (!Array.isArray(v.tips) || !v.tips.every((t) => typeof t === 'string')) {
    return fail('tips must be an array of strings');
  }
  if (typeof v.revised_prompt !== 'string') return fail('revised_prompt must be a string (empty if no rewrite)');

  // Return a clean copy: drops unknown fields, trims tips to the 3 the card shows.
  return {
    ok: true,
    value: {
      complexity: v.complexity,
      task_type: v.task_type,
      recommend: {
        model: r.model,
        effort: r.effort,
        workspace: r.workspace,
        fresh_chat: r.fresh_chat,
        output: r.output,
        tools_needed: r.tools_needed,
        schedule_candidate: r.schedule_candidate,
      },
      tips: v.tips.map((t) => t.trim()).filter(Boolean).slice(0, 3),
      est_relative_usage_saving: v.est_relative_usage_saving,
      revised_prompt: v.revised_prompt.trim(),
    },
  };
}
