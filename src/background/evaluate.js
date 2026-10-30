// Right-size ("Evaluate"): draft prompt + site + current model -> Nemotron recommendation.
import { getEvaluateConfig, getTokenFactoryConfig, resolveModel } from '../shared/config.js';
import { getCatalogue } from './models.js';
import { getSettings, unusedAllowanceLost } from '../shared/settings.js';
import { EVALUATE_SYSTEM, buildEvaluateUser } from '../shared/prompts.js';
import { validateEvaluate } from '../shared/schemas.js';
import { TIP_CODES, buildTips, parseEffort } from '../shared/tips.js';
import { nemotronJson, TokenFactoryError } from './tokenFactory.js';
import { latestAdvice } from './usage.js';
import { logEvaluate } from './outcomes.js';

// Keep the start and the end of long prompts (~1,000 tokens total at ~4 chars/token).
function capPrompt(prompt, maxChars) {
  if (prompt.length <= maxChars) return { excerpt: prompt, truncated: false };
  const head = Math.floor(maxChars * 0.75);
  return { excerpt: `${prompt.slice(0, head)}\n[...]\n${prompt.slice(-(maxChars - head))}`, truncated: true };
}

// Builds the Evaluate request. Shared with bench/ so the benchmark tests exactly what the extension sends.
export function buildEvaluateRequest({ mode, site, prompt, modelLabel, thread, usage, plan, catalogue, maxPromptChars }) {
  const text = prompt.trim();
  const currentModel = resolveModel(catalogue, modelLabel);
  const { excerpt, truncated } = capPrompt(text, maxPromptChars);
  return {
    currentModel,
    currentEffort: parseEffort(modelLabel),
    system: EVALUATE_SYSTEM[mode],
    user: buildEvaluateUser({
      site,
      currentModel,
      currentEffort: parseEffort(modelLabel),
      catalogue,
      plan,
      usage,
      thread,
      excerpt,
      truncated,
      approxPromptTokens: Math.ceil(text.length / 4),
    }),
    validate: (v) => validateEvaluate(v, catalogue.map((m) => m.id)),
    // Room for the JSON (~400 tokens) plus a revised prompt up to ~2x the draft's length.
    maxTokens: 400 + (truncated ? 0 : Math.min(1600, Math.ceil(excerpt.length / 2))),
    original: text,
    truncated,
  };
}

export async function evaluate({ site, prompt, modelLabel, thread, usage }) {
  if (!(prompt ?? '').trim()) throw new TokenFactoryError('Type your prompt first, then click Evaluate', 'empty');

  // The models in the user's picker, with researched facts where available (models.js).
  const catalogue = await getCatalogue(site, { currentLabel: modelLabel });
  if (!catalogue.length) throw new TokenFactoryError(`No model catalogue for ${site} in config/models.json`, 'config');

  const [settings, cfg, { mode, rules }] = await Promise.all([getSettings(), getTokenFactoryConfig(), getEvaluateConfig()]);
  const req = buildEvaluateRequest({
    mode,
    site,
    prompt,
    modelLabel,
    thread,
    usage: usage ?? (await latestAdvice()).forPrompt, // latest usage reading: pace, not raw page text
    plan: { type: settings.planType, unused_allowance_lost: unusedAllowanceLost(settings) },
    catalogue,
    maxPromptChars: cfg.maxPromptChars,
  });

  const result = await nemotronJson({ feature: 'evaluate', system: req.system, user: req.user, validate: req.validate, maxTokens: req.maxTokens });
  result.revised_prompt = cleanRevision(result.revised_prompt, req);
  // Safety net (bench case powerbi-plan, 2026-10-27): a new chat can't be made fresher, so no
  // "start a new chat" checkbox there, whatever the model said.
  // Same for a short chat (2026-10-30: "new chat" suggested after a 1-turn greeting): re-sending a few
  // hundred tokens of history costs next to nothing, so leaving it isn't worth the click. Drop the
  // model's tip about it too, so the card doesn't argue with its own checkbox.
  const SHORT_THREAD_TOKENS = 2000;
  if (!thread?.turns || (thread.approx_tokens ?? 0) < SHORT_THREAD_TOKENS) {
    if (result.recommend.fresh_chat && thread?.turns) result.tips = result.tips.filter((t) => !/\b(new|fresh) (chat|thread|conversation)\b/i.test(t));
    result.recommend.fresh_chat = false;
  }
  const out = mode === 'codes'
    ? applyRules(result, catalogue, req.currentModel, req.currentEffort, rules)
    : asIs(result, catalogue, req.currentModel);
  await logEvaluate({ site, currentModel: out.currentModel, recommendedModel: out.recommendedModel, currentEffort: req.currentEffort, effort: out.result.recommend.effort })
    .catch(() => {}); // the mileage summary is optional; never fail Evaluate over it
  return { ...out, currentEffort: req.currentEffort, seen: { modelLabel, thread } }; // what the page reader saw, shown on the card
}

// A revision is only offered for a draft sent in full, and only if it actually changes something.
export function cleanRevision(revised, { original, truncated }) {
  const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return !truncated && revised && norm(revised) !== norm(original) ? revised : '';
}

// 'free' mode: Nemotron's recommendation is used as returned.
function asIs(result, catalogue, currentModel) {
  const recommended = catalogue.find((m) => m.id === result.recommend.model);
  return {
    result,
    currentModel,
    recommendedModel: recommended,
    usageRatio: usageRatio(currentModel, recommended),
  };
}

// e.g. 1.7 = current model uses ~1.7x the allowance of the recommended one. null if either price is unknown.
function usageRatio(current, recommended) {
  return current?.relative_price && recommended?.relative_price ? current.relative_price / recommended.relative_price : null;
}

// 'codes' mode (fallback): Nemotron classifies; code derives model, effort, saving and tip wording
// from that classification so the card can't contradict itself.
export function applyRules(result, catalogue, currentModel, currentEffort, rules) {
  const tier = rules.tierByComplexity[result.complexity];
  const recommended =
    catalogue.filter((m) => m.tier === tier).sort((a, b) => (a.relative_price ?? Infinity) - (b.relative_price ?? Infinity))[0] ??
    catalogue.find((m) => m.id === result.recommend.model);
  const ratio = usageRatio(currentModel, recommended);

  const r = { ...result.recommend, model: recommended.id, effort: rules.effortByComplexity[result.complexity] };
  let saving = result.est_relative_usage_saving; // only Nemotron's guess if we couldn't read the current model
  if (ratio != null) {
    const t = rules.savingByUsageRatio;
    saving = ratio >= t.high ? 'high' : ratio >= t.medium ? 'medium' : ratio >= t.low ? 'low' : 'none';
    if (saving === 'none' && (r.fresh_chat || r.workspace === 'project')) saving = 'low';
  }

  const codes = [...new Set(result.tips)].filter((c) => TIP_CODES.includes(c)); // drop free text / unknown codes
  const tips = buildTips({ recommend: r, codes, currentModel, recommendedModel: recommended, usageRatio: ratio, currentEffort });

  return {
    result: { ...result, recommend: r, tips, est_relative_usage_saving: saving },
    currentModel,
    recommendedModel: recommended,
    usageRatio: ratio,
  };
}
