// Evaluate tips. Lightning only picks codes from BEHAVIOUR_TIPS; all wording lives here, so tips can't
// answer the user's question or contradict the card. Model/effort/fresh-chat/Project/web-search tips
// come from the recommendation itself (see buildTips).

export const BEHAVIOUR_TIPS = {
  narrow_scope: 'Narrow the scope: name the items you care about instead of “all”. Less to cover, less usage.',
  short_answer: 'Ask for a brief answer. Long replies use more allowance.',
  batch_questions: 'Batch related small questions into one message instead of sending several.',
};

export const TIP_CODES = Object.keys(BEHAVIOUR_TIPS);

const EFFORT_ORDER = ['low', 'medium', 'high', 'max'];

// Ordered by usage saved: savings first, then "spend more here" advice.
export function buildTips({ recommend, codes, currentModel, recommendedModel, usageRatio, currentEffort }) {
  const tips = [];
  const effortDelta = currentEffort ? EFFORT_ORDER.indexOf(recommend.effort) - EFFORT_ORDER.indexOf(currentEffort) : 0;
  const cap = (s) => s[0].toUpperCase() + s.slice(1);

  if (usageRatio > 1) {
    tips.push(`${recommendedModel.label} handles this well at about ${usageRatio.toFixed(1)}× less usage than ${currentModel.label}.`);
  }
  if (recommend.fresh_chat) {
    tips.push('Start a fresh chat: this is a new topic, and every turn re-reads the whole earlier conversation.');
  }
  if (effortDelta < 0) {
    tips.push(`Lower effort from ${cap(currentEffort)} to ${cap(recommend.effort)}: extra thinking adds usage without improving this answer.`);
  }
  if (recommend.workspace === 'project') {
    tips.push('Put documents you paste repeatedly into a Project instead of re-pasting them.');
  }
  for (const code of codes) tips.push(BEHAVIOUR_TIPS[code]);

  if (usageRatio != null && usageRatio < 1) {
    tips.push(`${recommendedModel.label} is worth it here: a weak first answer from ${currentModel.label} costs a retry.`);
  }
  if (effortDelta > 0) {
    tips.push(`Raise effort to ${cap(recommend.effort)}: multi-step work benefits from more thinking.`);
  }
  if (recommend.tools_needed) {
    tips.push('Turn on web search: current figures change, and without it the model guesses.');
  }
  return tips.slice(0, 3);
}

// Picker labels look like "Opus 5.5 Medium"; returns 'medium' or null. claude.ai levels: Low, Medium, High, Extra.
export function parseEffort(label) {
  return label?.toLowerCase().match(/\b(low|medium|high|extra|max)\b/)?.[1] ?? null;
}
