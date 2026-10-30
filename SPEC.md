# TokenMileage — Product Spec

**Tagline:** Get more mileage from every AI token.

A Chrome extension (Manifest V3) for people who use ChatGPT, Claude and similar AI chat sites. It uses NVIDIA Nemotron models on Nebius Token Factory to extract more value from every token: spend it on the right model, use it before it expires, keep everything it creates, and reuse what you've already paid for.

Built for the **Nebius x NVIDIA Global AI Hackathon** (Devpost). Submission deadline: **Oct 30, 2026, 10:00 am PT (10:30 pm IST)**.

---

## 1. Problem

- Companies are throttling employee AI use because token costs are spiralling; employees default to the most expensive model for simple tasks.
- Individuals on flat plans (e.g. Claude Pro/Max) hit 5-hour session and weekly limits; model choice, effort level, conversation length, tool use and attachments all affect how fast limits are consumed.
- Generated scripts, files and artifacts get lost across long conversations and fresh chats; nothing tracks whether they are backed up locally.
- Users don't know what they created over a month/quarter, what they actually reuse, or what they forgot.

## 2. Product: four ways to get more mileage

| Step | Feature | Value it extracts |
|---|---|---|
| Spend right | Right-size: model, effort, conversation, workspace advice | Same result for less allowance |
| Use fully | Usage alerts + next-prompt suggestions | Expiring allowance becomes finished work |
| Keep everything | Asset vault: auto-capture, smart naming, auto-save with chat identity | Nothing paid for is lost |
| Reuse & reflect | Period dashboard of everything created ("Tokenomics" panel for usage and value) | Past work found and reused, not regenerated |

### 2.1 Right-size ("Evaluate" button) — CORE
- Overlay button next to the chat input on supported sites.
- On click: read draft prompt + site + currently selected model; call **Lightning** (reasoning OFF) with a capped input (~1,000 tokens of the prompt max).
- Lightning returns JSON (see §5). Show a small card with top 2–3 tips ranked by estimated saving.
- The same call returns a **suggested prompt**: the draft rewritten for the recommended model, keeping the user's intent, facts and pasted content, adding only what makes the first answer right at the least usage (clear deliverable, scope, length). Never invents requirements, never answers the draft. Not offered when the draft was too long to send in full.
- Card buttons: **Apply** (fill in the suggested prompt + switch model/effort in the site's picker; user presses send) and **Apply & send** (same, then sends). Every change is verified on the page first; if the model/effort switch can't be confirmed, nothing is sent.
- Usage-coach tips (from Claude's own usage-limit guidance): lower effort, start a fresh chat when the thread is long, use a Project for repeatedly pasted documents, skip web search/research when not needed, batch small questions.
- Budget-aware: if lots of allowance is left and resets soon, it's OK to recommend the bigger model; if low, recommend the smaller one.
- Model catalogue per site lives in an editable config file (`config/models.json`) with tier + relative price. Never hard-code model names in logic.
- **Live model list + model research (added 2026-10-27, also for the Tavily prize):** the list of models comes from the site's own picker (names + the site's descriptions), so new and older versions are covered and unavailable ones aren't recommended. Config holds family defaults. A Nemotron 3 Super agent with Tavily search/extract tools finds each model's best uses and API price on the vendor's official sites. Code checks every fact against the fetched text and keeps the sources. Evaluate gets `best_for` + `price_source` and prefers the model whose strengths fit the task within the right size.

### 2.2 Asset vault + auto-save — CORE
- Content script watches responses (MutationObserver) and captures: code blocks above a minimum size, artifacts, downloadable file cards, long structured outputs.
- Per item store: type, site, chat URL, chat title, created date, fingerprint (hash), version, saved status, open/reuse counts.
- **Lightning** names each item from a short excerpt: title, one-line summary, language, tags, topic folder.
- Auto-save toggle per site. Save via `chrome.downloads` into `Downloads/AI-Vault/<site>/<date>_<chat-slug>_<chatId>/`.
- For OneDrive/Google Drive: user points the vault at their locally synced folder (no cloud API in MVP).
- Every save folder gets `_chat.json` (chat link, title, date, site, model, prompt that produced each file). Code files get a header comment with the source chat link.
- Dedupe by hash; updated artifacts saved as `_v2`, `_v3`.
- Secret check: warn before saving files that look like they contain API keys/passwords.
- "Save this chat now" button for older chats (backfill).
- Carry-over pack: when suggesting a fresh chat, prepare a short summary of the thread + list of assets created, ready to paste.

### 2.3 Dashboard — CORE (MVP slice)
- Extension page reading local IndexedDB. Charting library must be **bundled** (MV3 forbids remote code).
- Period picker: month / quarter / year / custom.
- Cards: Created, Saved %, Reused %, Forgotten (never opened since), At risk (never saved).
- Chart: items by type. Click → full list for that type and period (title, type, date, site, saved status, reuse count, open file, open chat).
- Types (Lightning classifies): Code (by language), Documents, Design, Data, Presentations, Media, Prompts & templates.
- Monthly narrative recap via Lightning ("In September you created 47 items…").
- "Usage now" panel: session/weekly gauges, reset countdowns.

### 2.4 Usage alerts — CORE (Claude only)
- Read session % / weekly % / reset times from Claude's usage page when the user is on Claude (no hidden polling; show "last updated").
- Extension badge: e.g. `78% · 2h 10m`.
- Alerts with user thresholds + quiet hours: use-it alert, pace warning, near-limit warning.
- Plan type asked at setup: flat/limit plans get use-it alerts; usage-based (pay per use) plans get pacing only, never "use it" nudges.

### 2.5 Next-prompt suggestions — CORE (MVP slice)
- During capture, Lightning extracts "open loops" per chat: AI-suggested next steps not taken, things the user said they'd do, unresolved errors, drafts stuck mid-way, deadlines mentioned. Store only these short summaries.
- **Ultra** periodically (and when a use-it alert fires) ranks open loops + manual queue items into top-3 suggestions, each with a one-line reason, target chat and recommended model.
- Ranking signals: deadline proximity, staleness, starred project, allowance left, dependencies, past dismissals.
- Approve → open the original chat (or fresh chat + carry-over pack) and **pre-fill** the prompt. User presses send. Never auto-send in MVP.

## 3. 9-day scope

| Build now | Roadmap slide only |
|---|---|
| Right-size: model, effort, fresh-chat nudge, Project tip, suggested prompt, Apply / Apply & send (switches model picker) | Schedule detection, artifact-vs-chat advice |
| — | Vault (§2.2): capture, naming, auto-save, `_chat.json`, dedupe/versions. Removed from the build on 2026-10-26; direct OneDrive/Drive APIs, bulk retroactive backup |
| Dashboard: period picker, cards, by-type chart, drill-down list, monthly recap | Yearly Ultra review, topic charts, comparison mode |
| Usage alerts on Claude: checked on page load (use it / slow down / near limit from usage vs. time to reset), badge, plan-type setting | Other sites' limits, quiet hours |
| Next-prompt: open-loop extraction, top-3 panel, approve → pre-fill | Dependency tracking, learning from dismissals, auto-send |
| Sites: Claude + ChatGPT | Gemini and others |

Suggested order: (1) Token Factory client + Lightning JSON contract → (2) Evaluate button on Claude → (3) capture + naming + auto-save → (4) usage reader + alerts → (5) dashboard → (6) open loops + Ultra suggestions → (7) ChatGPT reader → (8) offline validation benchmark → (9) README, Devpost text, demo video.

## 4. Models (Nebius Token Factory)

| Model | Use | Notes |
|---|---|---|
| Nemotron 3.5 Lightning (30B, ~3B active) | All frequent calls: classify, name, extract open loops, monthly recap | Listed ID `nvidia/Nemotron-3_5-Lightning`; ~$0.06 / $0.24 per M tokens (third-party listing — confirm in console). Turn reasoning OFF for classification. |
| Nemotron 3 Ultra (550B, 55B active) | Occasional planning: rank suggestions; offline validation judge. **Evaluate** (chosen by benchmark, 2026-10-22) | Confirm ID and price in console. |
| Nemotron 3 Super (120B, 12B active) | Model research agent with Tavily tools (background, ~once per model per month). Chosen by benchmark 2026-10-27 (README, NEBIUS_FEEDBACK item 6) | Tool calling works on all 4 Nemotrons; fixed pipeline fallback kept. |

- API is OpenAI-compatible. Base URL seen on Nebius's site: `https://api.tokenfactory.us-central1.nebius.com/v1/` (also seen: `https://api.tokenfactory.nebius.com/v1`) — confirm in console.
- Estimated running cost for a heavy user: ~$0.70/month (3,000 evaluations, 300 namings, 200 open-loop extractions, daily Ultra planning).

## 5. Lightning contract — Evaluate

```json
{
  "complexity": "simple | standard | complex",
  "task_type": "reformat | summarise | code | analysis | writing | research | other",
  "recommend": {
    "model": "<model id from site catalogue>",
    "effort": "low | medium | high",
    "workspace": "chat | project",
    "fresh_chat": false,
    "output": "chat | artifact",
    "tools_needed": false,
    "schedule_candidate": false
  },
  "tips": ["<max 3 short tips>"],
  "est_relative_usage_saving": "none | low | medium | high",
  "revised_prompt": "<suggested prompt, or empty string>"
}
```

## 6. Validation (credibility for judges)
- Offline benchmark: ~100 sample prompts with a mix of complexity.
- Run each on the cheaper recommended model and the expensive model; Ultra judges (blind, side-by-side) whether the cheap answer was good enough.
- Report hit rate: "When we said a smaller model was enough, it was right N% of the time."
- Show estimated relative usage based on API price ratios, labelled as estimates (Anthropic doesn't publish exact per-model subscription limits).

## 7. Privacy rules
- All captured content and the index stay in the browser (IndexedDB) or the user's chosen folder.
- Only short excerpts go to Nebius, and only for features the user enabled; nothing stored server-side.
- Evaluate is user-initiated (or opt-in auto-evaluate per site). "Never run on this site/chat" settings.
- Repeat detection uses hashes/fingerprints, never full text.
- Default save location local/company-approved; warn that copying AI output to personal cloud drives may breach company data policies.

## 8. Hackathon requirements checklist
- [ ] Runtime calls to Nebius Token Factory using NVIDIA open models (Lightning, Ultra)
- [ ] Track: Personal AI or Best Apps and Agents (decide; Personal AI suggests NemoClaw/OpenShell/Hermes tooling)
- [ ] Public repo (GitHub/GitLab/Bitbucket) with open-source license visible in About (MIT/Apache 2.0/MPL 2.0)
- [ ] README: setup steps, how Nemotron/Token Factory are used, other Nebius services
- [ ] Working demo: downloadable test build of the extension
- [ ] Demo video < 3 min, public on YouTube, no copyrighted music
- [ ] Text description: what, why, how
- [ ] Feedback on Token Factory / NVIDIA models (eligible for Most Valuable Feedback prize)
- [ ] Explain what was built during the submission period

## 9. Pitch
- "Get more mileage from every AI token." More work from the same AI budget, whatever the budget is measured in (dollars, session limits, weekly caps).
- Positioning: not just saving tokens — extracting more value from them: spend right, use fully, keep everything, reuse and reflect.
- Costs ~$0.70/month to run; can save tens of dollars on usage-based plans or stretch flat plans noticeably.
- vs Prompt Perfect (~$9/month paid tier, 1 free perfect prompt/day): that makes prompts better; this saves money and keeps your work safe.
- Honest limits: chat-only (agentic coding tools are the biggest spenders — future org gateway), estimates labelled as estimates, page readers can break when sites change.
