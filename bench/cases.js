// Evaluate benchmark cases. Synthetic drafts (no real user data); several mirror cases seen on claude.ai.
// expect: allowed values per field (omit a field to skip that check).
//   complexity: allowed complexities
//   tools / fresh: expected booleans for recommend.tools_needed / recommend.fresh_chat
//   answerLeak: regex - a tip matching it is answering the draft instead of coaching usage
//   allowFormat: the task itself is about format, so tips mentioning tables/bullets are fine
//   revise: whether a revised prompt is expected (vague drafts: true); answerLeak also applies to it
//   keep: strings (pasted data, code) the revised prompt must contain exactly
//   openChoice: options the user left open; the rewrite may name none or all, never pick some
//   noAdd: regex - scope changes or answer content the rewrite must not add

const NEW_CHAT = { turns: 0, approx_tokens: 0, title: null };
const PRODUCTIVITY = { turns: 9, approx_tokens: 20000, title: 'Productivity tools' };

const LONG_DOC = Array.from({ length: 40 }, (_, i) =>
  `Section ${i + 1}: Revenue in the region grew modestly while operating costs rose due to logistics and hiring; management expects margins to stabilise next quarter.`,
).join(' ');

export const CASES = [
  {
    id: 'dir-command',
    note: 'seen live 2026-10-21: tips answered the question (use dir, add /b)',
    modelLabel: 'Opus 5.5 Medium',
    thread: NEW_CHAT,
    draft: 'list command to show current directory files in windows',
    expect: { complexity: ['simple'], tools: false, fresh: false, answerLeak: /\bdir\b|\/b\b|\bls\b|get-childitem|gci\b/i },
  },
  {
    id: 'list-files-on-haiku',
    note: 'seen live 2026-10-24 (Ultra): already on Haiku, card said Saving: high and gave a thread-length tip in a new chat',
    modelLabel: 'Haiku 5.5 Medium',
    thread: NEW_CHAT,
    draft: 'command to list files',
    // 2026-10-24 rewrite guessed "on Linux/macOS" for a Windows user
    expect: { complexity: ['simple'], tools: false, fresh: false, revise: true, openChoice: [/windows/i, /linux/i, /mac/i], answerLeak: /\bdir\b|\/b\b|\bls\b|get-childitem|gci\b/i },
  },
  {
    id: 'time-now',
    note: 'seen live 2026-10-27 (Ultra): "what time it is" was rewritten to "What is the current time in UTC?"',
    modelLabel: 'Haiku 5.5 Low',
    thread: { turns: 1, approx_tokens: 600, title: 'Claude models with internet and web search' },
    draft: 'what time it is',
    // Any named time zone is a guess (all of them can't be listed): the rewrite may only ask for the zone to be stated.
    expect: { complexity: ['simple'], noAdd: /\b(UTC|GMT|IST|PST|PDT|EST|EDT|CET|BST)\b/ },
  },
  {
    id: 'reformat-table',
    modelLabel: 'Sonnet 5.5 Medium',
    thread: NEW_CHAT,
    draft: 'convert this list to a markdown table with columns colour and count: red 3, blue 5, green 2, yellow 7',
    expect: { complexity: ['simple'], tools: false, fresh: false, allowFormat: true, keep: ['red 3', 'blue 5', 'green 2', 'yellow 7'], answerLeak: /\|\s*red|\bcolou?r\s*\|/i },
  },
  {
    id: 'user-guide-in-thread',
    note: 'seen live 2026-10-22: refers back to the conversation',
    modelLabel: 'Opus 5.5 Medium',
    thread: PRODUCTIVITY,
    draft: 'create a user guide for this extension',
    expect: { complexity: ['standard'], tools: false, fresh: false },
  },
  {
    id: 'stocks-on-haiku',
    note: 'seen live 2026-10-22: complex/research but recommended Haiku, saving medium',
    modelLabel: 'Haiku 5.5 Medium',
    thread: PRODUCTIVITY,
    draft: 'analyze all stocks related to AI domain fundamentally and list current value, fair value, expected value in next 5 years, reason for the same',
    // 2026-10-24 rewrites narrowed "all" to "top 10", added exclusions and named valuation methods
    expect: { complexity: ['complex'], tools: true, fresh: true, revise: true, noAdd: /\btop \d+|\bexclud|\bDCF\b|multiples|semiconductor/i, answerLeak: /nvidia|nvda|msft|microsoft|p\/e|discounted cash/i },
  },
  {
    id: 'stocks-on-opus',
    note: 'seen live 2026-10-22: tip told user to switch to Sonnet while card said Opus',
    modelLabel: 'Opus 5.5 Medium',
    thread: PRODUCTIVITY,
    draft: 'analyze all stocks related to AI domain fundamentally and list current value, fair value, expected value in next 5 years, reason for the same',
    expect: { complexity: ['complex'], tools: true, fresh: true, revise: true, noAdd: /\btop \d+|\bexclud|\bDCF\b|multiples|semiconductor/i, answerLeak: /nvidia|nvda|msft|microsoft|p\/e|discounted cash/i },
  },
  {
    id: 'schema-design',
    modelLabel: 'Sonnet 5.5 Medium',
    thread: NEW_CHAT,
    draft: 'design a database schema for a multi-tenant SaaS billing system with usage-based pricing, invoices, credits and proration, and explain the trade-offs of each table design',
    // 2026-10-24 rewrite listed the tables and trade-offs itself (partial design)
    expect: { complexity: ['complex'], tools: false, fresh: false, noAdd: /ledger|denormali|usage_events|\(tenants|subscriptions,/i, answerLeak: /tenant_id|foreign key|uuid/i },
  },
  {
    id: 'powerbi-plan',
    note: 'seen live 2026-10-25 (Ultra): one-line draft expanded into a detailed brief; the user wants this level of detail',
    modelLabel: 'Haiku 5.5 Low',
    thread: NEW_CHAT,
    draft: "create a plan to move our team's monthly reports from excel to power bi",
    expect: { complexity: ['complex', 'standard'], tools: false, fresh: false, revise: true },
  },
  {
    id: 'capital-in-long-thread',
    modelLabel: 'Opus 5.5 High',
    thread: { turns: 32, approx_tokens: 48000, title: 'Python data pipeline refactor' },
    draft: 'what is the capital of Australia?',
    expect: { complexity: ['simple'], tools: false, fresh: true, answerLeak: /canberra|sydney/i },
  },
  {
    id: 'news-today',
    modelLabel: 'Sonnet 5.5 Medium',
    thread: NEW_CHAT,
    draft: "what are today's top headlines about AI regulation?",
    expect: { complexity: ['simple', 'standard'], tools: true, fresh: false },
  },
  {
    id: 'summarise-pasted',
    modelLabel: 'Opus 5.5 Medium',
    thread: NEW_CHAT,
    draft: `Summarise this report in 5 bullet points:\n${LONG_DOC}`,
    expect: { complexity: ['simple', 'standard'], tools: false, fresh: false, allowFormat: true, answerLeak: /margins? (will )?stabili[sz]e|logistics/i },
  },
  {
    id: 'debug-race',
    modelLabel: 'Haiku 5.5 Low',
    thread: { turns: 4, approx_tokens: 6000, title: 'Order service bug' },
    draft: `My Java order service sometimes double-charges customers under load. Here is the code:
public void pay(Order o) { if (!o.isPaid()) { gateway.charge(o); o.setPaid(true); repo.save(o); } }
It runs on 4 pods behind a load balancer. Why does this happen and how do I fix it properly?`,
    expect: { complexity: ['standard', 'complex'], tools: false, fresh: false, keep: ['gateway.charge(o)', 'o.setPaid(true)'], noAdd: /race condition|constraint|thread-safe|distributed/i, answerLeak: /idempoten|lock|synchroni[sz]ed|transaction/i },
  },
];
