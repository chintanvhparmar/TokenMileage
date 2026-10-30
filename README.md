# TokenMileage

**Get more mileage from every AI token.**

A Chrome extension (Manifest V3) for ChatGPT/Claude users. It uses NVIDIA Nemotron models on Nebius Token Factory to spend each token on the right model, use allowance before it expires, keep everything the AI creates, and reuse past work. Built for the Nebius x NVIDIA Global AI Hackathon.

## Status

| Feature | State |
|---|---|
| Token Factory client + Lightning JSON contract (Evaluate) | ✅ built |
| Evaluate button on claude.ai | ✅ working end to end (Nemotron 3 Ultra, chosen by benchmark) |
| Suggested prompt + Apply / Apply & send (fills in the prompt, switches model and effort in claude.ai's picker, sends) | ✅ working on claude.ai |
| Options page (API key, base URL, Nemotron models in use, plan type incl. monthly spend limit + fixed-fee toggle, sites) | ✅ built |
| Usage alerts on claude.ai: on page load, "use it" / "slow down" / "near limit" advice from usage vs. time to reset, toolbar badge, thresholds on the options page; Evaluate sees the pace | ✅ built (Enterprise spend limit: being tested; Pro/Max API reader not yet verified) |
| Live model list: models read from claude.ai's own picker (incl. "More models"), so new and older versions are covered | ✅ built (being tested) |
| Model research agent: Nemotron 3 Super + Tavily tools find each model's best uses and API price on the vendor's sites, with sources; Evaluate uses them | ✅ built; Nemotron model chosen by benchmark (in-extension run being tested) |
| Dashboard (toolbar icon): your mileage (cost cut on switched messages), five levers, model mix before/after, plan pacing, recent changes; plus a per-message note on the card after each switch | ✅ built (being tested) |
| AI-Vault (auto-save what the AI creates) | ⏸ removed for now (roadmap) |
| Next-prompt, ChatGPT | ⏳ not yet |

## Setup

1. Get an API key from the Nebius Token Factory console.
2. In Chrome open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick this folder (there is no build step).
3. The options page opens on install (or click the toolbar icon). Paste the key and click **Save & test connection**. The test lists Token Factory models (no tokens used) and confirms every Nemotron model the extension uses exists.
   Optional: paste a Tavily API key (app.tavily.com) for model research. The test then also makes one Tavily search (1 credit).
4. Open claude.ai, type a prompt and click **Evaluate** above the input box.

After changing code, click the reload icon on the extension card and refresh claude.ai.

## How Nemotron / Token Factory are used

- **Evaluate → Nemotron 3 Ultra** (`/v1/chat/completions`, reasoning off via `chat_template_kwargs.enable_thinking: false`, temperature 0, streaming).
  - **Input:** the draft prompt (capped at ~1,000 tokens), the site's model catalogue, the current model and effort, the chat title and thread counts. No conversation text.
  - **Output:** strict JSON (SPEC §5) in which Ultra decides the model, effort, saving and tips, and writes a **suggested prompt**: the draft rewritten for the recommended model without changing its intent or pasted content. It's validated against the schema; invalid output is retried once, then the card shows an error.
  - **Apply / Apply & send:** the card shows the suggested prompt (editable). **Apply** fills it in and switches model and effort in claude.ai's picker; **Apply & send** also sends. When Ultra recommends a fresh chat, a ticked **Start a new chat** option opens a new chat first and moves the prompt there. Each change is checked on the page first, and nothing is sent if the switch can't be confirmed.
  - **Why Ultra and not Lightning:** on our benchmark, Ultra with reasoning off passed 9/10 cases at 0.8 s and about $0.0016 per call (~$5 for 3,000 Evaluates). Lightning passed 4/10 at 7.1 s. Details are in `NEBIUS_FEEDBACK.md` item 5 and `bench/results/`.
  - **Fallback:** `config/models.json` → `evaluateMode: "codes"`, where Nemotron classifies and rules decide. It isn't used, because Ultra didn't need it.
- **Model research → Nemotron 3 Super as an agent with Tavily tools** (see below). It runs in the background, once per model per month. Chosen by benchmark (2026-10-27): Super matched Ultra's accuracy (10/10 prices consistent) at about a fifth of the cost and half the time. Nano and Lightning sometimes took the wrong price row or copied the prompt's example phrases.
- **Nemotron 3.5 Lightning** is the default for other frequent calls (open loops). Each will be benchmarked when built.
- The model for each feature is set in `config/tokenfactory.json` → `taskModels` (shown read-only on the options page).

## Which models you can pick, and what they're for (Tavily + Nemotron)

New models ship often, older versions stay under "More models", and admins can switch some off. A fixed model list goes out of date, so TokenMileage reads the list from claude.ai itself and researches each model on the web.

1. **The model list comes from the picker** (`src/content/sites/claude.js`). Whenever you open claude.ai's model menu, the reader notes each model's name and claude.ai's own one-line description (e.g. "Most efficient for everyday tasks"). Once a day, when you click Evaluate, it also opens the menu and "More models" itself to read the full list. Evaluate then only recommends models you actually have.
2. **Defaults by model family** (`config/models.json` → `families`). A model that hasn't been researched yet gets its family's typical size, estimated price and uses: a new "Sonnet 6" is treated like the last Sonnet. These are marked as estimates.
3. **A research agent finds the facts** (`src/background/research.js`). For each model, **Nemotron 3 Super** gets two tools and decides how to use them:
   - `tavily_search`: Tavily search, restricted in code to the vendor's official sites (`anthropic.com`, `claude.com`, docs). The agent can't search anywhere else.
   - `tavily_extract`: Tavily extract with a `query`, so only the relevant parts of a page come back. This keeps Nemotron's input small.

   The first search is always the same (`<vendor> <model> model pricing and what it is best for`), so code runs it and hands the results to Nemotron as if it had asked for them. That saves one Nemotron call. From there, the agent decides which pages to read and whether to search again (at most 4 Tavily calls, including the first search). It then returns strict JSON with `best_for`, `size_class`, API price per million tokens, context window, release date and sources, which is validated against a schema.
4. **Code checks the facts against the pages** before keeping them:
   - The model's exact name and version must appear in the text Tavily returned.
   - Each price must appear right after that name, e.g. in the same pricing-table row, so another model's price can't be used.
   - Sources must be pages that were actually fetched.

   Anything that fails is dropped, and the family default stays. If Token Factory rejects tool calls, or the model answers without using a tool, a fixed search → extract → read pipeline runs instead. Which path ran is recorded.
5. **Evaluate uses the results.** Each model is sent with its size, relative price, `price_source` (`published` / `estimated` / `unknown`), best uses and claude.ai's description. Nemotron picks the right size first, then the model whose strengths fit the task. It never claims a saving based on an unknown price. The card shows, for example, "Sonnet 6: good for agentic coding, computer use · anthropic.com", linked to the source, and says whether the cost comparison comes from published API prices or is an estimate.

Results are cached in `chrome.storage.local` and re-checked every 30 days, or straight away with **Re-check** on the options page. The **Models on claude.ai** table there shows each model's size, cost, best uses, sources and when it was researched. Researching one model costs about 1.5 Tavily credits and 7,000 Super tokens (about $0.002) and takes about 4 s (benchmark, 2026-10-27). Only model names and vendor domains are sent to Tavily.

## Your mileage (dashboard)

TokenMileage shows what it actually changed, not just what it advised:
- **On the card**, after a confirmed switch: e.g. "Sent. About 98% less than Opus 4.6 for this message (published prices)", or "A stronger model for a better first answer (20× the usage)" when it moved you up.
- **On the dashboard** (click the toolbar icon; `src/dashboard/`), for this month, the last 30 days or all time:
  - **Headline:** the cost cut on messages moved to a cheaper model, versus staying on the model you had. It assumes the same message on both models and uses relative prices recorded at the time. Next to it: prompts evaluated, chat-history tokens not re-sent, and TokenMileage's own AI cost.
  - **Five levers:** why chat usage grows and what changed for each: right-size the model (moves to a cheaper model), move up when it matters (fewer retries), right effort (effort lowered), lean context (fresh chats), right first time (prompts rewritten and sent).
  - **Model mix:** the share of evaluated prompts on small, medium and large models, before and after the switches you confirmed.
  - **Plan pacing:** allowance used against the share of the period gone, with the current advice.
  - **Recent changes:** the last confirmed changes (models, effort, flags; never prompt text).

Only confirmed changes count: the model switch and prompt were checked on the page. The log (`chrome.storage.local` → `outcomes`, code in `src/background/outcomes.js`) holds model ids, efforts, flags and numbers. It never holds prompt text or chat titles.

## Usage alerts (claude.ai)

When you open claude.ai, TokenMileage compares the share of your allowance used with the share of the period gone (`src/shared/pacing.js`), then shows advice above the input box and a badge on the toolbar icon (e.g. `15%`):
- **Use it before it resets:** on pace to use less than 75% by the reset, in the second half of the period. Only shown when unused allowance is lost: flat plans (Pro/Max), or spend limits with the fixed-fee toggle on. Usage-based plans only get pacing advice. Never shown for 5-hour sessions.
- **Slow down:** on pace to use over 110% before the reset. Says roughly when you'd hit the limit.
- **Near limit:** 90% or more used.
- **On track:** a short notice only.

A pill next to Evaluate always shows the current figures, e.g. `$121 of $500 · 24% · resets Sun, Nov 1`, coloured by the advice. Click it to open the full usage card. The figures are re-read 5 s after each Claude reply finishes, when you return to the tab (after a minute or more), and when you switch chats, at most once every 15 s. These refreshes update the pill and badge, and show the card only if the advice changes.

The advice shows on every page load. Closing it with × hides the same advice for 5 minutes (set 0–1440 on the options page; 0 = every load). Different advice shows straight away. All thresholds can be changed on the options page.

Where the numbers come from: on every page load, the claude.ai reader fetches the same usage data that claude.ai's Settings → Usage page loads (`/api/organizations/<org>/usage`), with your existing login. You never need to open the usage page.
- **Enterprise spend limit:** `spend.used` / `spend.limit` (amounts in cents), falling back to `extra_usage`. The response has no reset date. The page shows "Resets Sun, Nov 1, 5:30 AM GMT+5:30", which is 00:00 UTC on the 1st, so the period is the calendar month in UTC. Verified on an Enterprise account on 2026-10-27.
- **Pro/Max session and weekly limits:** `five_hour` / `seven_day` (`utilization`, `resets_at`). On these plans the spend fields describe paid extra usage, so they're ignored. Not yet verified on a Pro/Max account.
- **Fallback:** if that request fails, the text on Settings → Usage is read whenever you open it, and the card shows how old the reading is.

Evaluate also gets the pace (status, % used, % of period gone, projected % at reset, hours to reset), so it can lean to a bigger model when allowance would otherwise be lost and to a smaller one when you're running out.

Every call logs counts only (no text) to `chrome.storage.local` → `usageLog`: tokens for Token Factory, credits for Tavily. Totals are shown on the options page.

## Nemotron benchmark (`bench/`)

Options page → **Open Nemotron benchmark**. It runs inside the extension with your saved key:

1. **API probe**: per Nemotron model (Nano, Lightning, Super, Ultra), compares streaming vs non-streaming, each reasoning switch and JSON-schema output, and records latency, time to first token, tokens and reasoning length.
2. **Evaluate quality**: 11 realistic drafts (`bench/cases.js`) × models × reasoning off/on × prompt variant, auto-scored:
   - valid JSON
   - correct complexity, web-search need and fresh-chat call
   - self-consistent model, effort and saving
   - tips that coach rather than answer the question, don't contradict the card, and aren't formatting advice
   - no new-chat or history tips unless the card recommends a fresh chat
   - suggested prompt: offered for vague drafts, never contains the answer, keeps pasted data and code exactly, doesn't guess open details (e.g. OS) or change the scope

Latest runs (2026-10-27, Ultra, reasoning off, 13 cases): 12/13 pass every check on the final prompt (11/13 in each of the three runs before it), median 1.3–2.5 s, about $0.002 per Evaluate including the suggested prompt. Each prompt fix was made for a specific miss (details in `NEBIUS_FEEDBACK.md` item 5). The remaining misses are harmless tips: a filler "thread context is relevant" tip, and occasionally a format tip such as "ask for a bullet list".

3. **Model research**: each selected Nemotron model researches the claude.ai models from your picker, as an agent with Tavily tools and as the fixed pipeline. It doesn't change the stored model facts. Per run it records:
   - whether the agent made tool calls itself, or fell back to the pipeline because tools were rejected
   - best uses, price and size found
   - facts dropped by the checks against the fetched pages
   - whether the price agrees with the most common price found for that model across all runs (a cross-check, since new models have no answer key)
   - Tavily credits, tokens, estimated cost and time

   Latest run (2026-10-27, 11 models from the claude.ai picker, Haiku 4.5 to Opus 5.5, including the retired Opus 3; 88 runs; raw file in `bench/results/`):

   | Nemotron | Method | Price agrees* | Own tool calls | Tavily credits / model | Tokens / model | Cost / model | Avg time |
   |---|---|---|---|---|---|---|---|
   | Nano | agent | 9/10 | 1.1 | 1.4 | 6.3k | $0.0004 | 7.3 s |
   | Nano | pipeline | 9/10 | – | 1.6 | 4.1k | $0.0003 | 3.4 s |
   | Lightning | agent | 10/10 | 3.0 | 2.8 | 17.2k | $0.0011 | 12.0 s |
   | Lightning | pipeline | 8/10 | – | 1.6 | 4.1k | $0.0003 | 3.0 s |
   | **Super** | **agent** | **10/10** | 1.0 | **1.5** | 7.1k | **$0.0023** | **3.8 s** |
   | Super | pipeline | 10/10 | – | 1.6 | 4.5k | $0.0014 | 2.8 s |
   | Ultra | agent | 10/10 | 2.1 | 2.4 | 12.4k | $0.0130 | 7.5 s |
   | Ultra | pipeline | 10/10 | – | 1.6 | 4.1k | $0.0044 | 2.8 s |

   \*Price found and equal to the most common price for that model across all 88 runs. 10 of the 11 models have a published price; Opus 3 (retired) has none, and no run invented one. The majority prices match Anthropic's well-known ones where we know them (Haiku 4.5 $1/$5, Sonnet 4.6 $3/$15).

   - **Tool calling works on all four Nemotron models on Token Factory** (reasoning off): no run fell back to the pipeline.
   - **Super uses the tools efficiently.** After the first search (run by code), it typically makes one extract call and answers. Lightning always used its whole budget, with filler searches such as "size class small medium large lineup". Ultra searched more for optional fields like the context window.
   - **Wrong prices that passed the checks:** Nano (both methods) and the Lightning pipeline returned $10/$37.50 for Opus 4.6, which looks like a long-context price row near the model's name. The Lightning pipeline also returned $0.01/$0.05 for Haiku 5.5. Super and Ultra were never wrong. The "price right after the name" check stops prices taken from other models, not other price rows for the same model.
   - **Copying the prompt's examples:** Nano gave 4 best-use lists made of the prompt's example phrases (e.g. "fast simple tasks" for Opus 4.8). Super and Ultra did this 0 times. For the retired Opus 3, Super and Ultra reported what the source says ("philosophical reflection, creative expression"). Nano and Lightning gave generic Opus phrases.
   - **Agent vs pipeline:** for Anthropic's well-structured pages, Super's pipeline was as accurate and slightly cheaper. The agent costs about 1 s and $0.001 more per model. We keep the agent because it adapts when the first search misses, e.g. for new models or other vendors' pages.

**Download results JSON** saves everything; the findings go into `NEBIUS_FEEDBACK.md`. `config/models.json` → `evaluateMode` selects `free` (Nemotron decides everything) or the `codes` fallback.

## Configuration

- `config/tokenfactory.json`: base URL, model IDs, prices, reasoning-off switch, JSON mode. **Confirm these in the Token Factory console.** If Token Factory rejects `response_format`, set `jsonMode` to `false`.
- `config/models.json`: per site, model-family defaults (tier, estimated relative price, typical uses), the official domains research may search, and a fallback model list used until the picker has been read. Relative prices are estimates until research finds published prices.
- `config/tokenfactory.json` → `research`: tool-call budget, re-check interval and page size for the research agent.

## Layout

```
manifest.json
config/              tokenfactory.json, models.json
icons/               extension icon (16, 32, 48, 128 px)
src/background/      service worker, Token Factory client, Tavily client, evaluate, model list + research agent, usage alerts + badge, usage log
src/content/sites/   per-site DOM readers (selectors live only here)
src/content/overlay/ Evaluate button, recommendation and usage cards (Shadow DOM)
src/content/main.js  content-script entry point
src/options/         options page
src/shared/          settings, config loader, JSON schemas, prompt templates, usage pacing
bench/               Nemotron benchmark page
src/dashboard/       dashboard: mileage, levers, model mix, pacing, recent changes
```

## Privacy

- Your API key stays in this browser and is sent only to Token Factory.
- Evaluate only runs when you click it, and sends a capped excerpt of the draft prompt plus the chat title and counts (thread turns and approximate tokens). It never sends conversation text.
- To count a long chat correctly, the claude.ai reader loads the conversation the same way claude.ai's own page does, inside the page, using your existing login. Only the two counts leave the page. claude.ai only shows messages near your scroll position, so the fallback (counting what's on screen) is marked "visible only" on the card.
- Usage alerts stay in the browser: only the numbers (amount used, limit, reset time) are kept in `chrome.storage.local`. Nothing about usage is sent anywhere except the pace summary included in an Evaluate call.
- Model research sends only model names (e.g. "Sonnet 6") and the vendor's domains to Tavily, and Tavily's page excerpts to Token Factory. Nothing from your chats goes to either. The Tavily key is stored only in this browser.
- TokenMileage only sends a prompt when you click **Apply & send** on its card, and only after confirming the prompt, model and effort on the page. **Apply** fills in without sending.

## License

MIT, see [LICENSE](LICENSE).
