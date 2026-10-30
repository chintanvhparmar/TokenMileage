# CLAUDE.md — TokenMileage

Product name: **TokenMileage** — "Get more mileage from every AI token." Use this name in the manifest, UI, README and repo.

Read `SPEC.md` first: it is the source of truth for scope, features and the 9-day cut line. Don't build anything listed under "Roadmap slide only" unless asked.

## Context
- Solo build by Joy for the Nebius x NVIDIA Global AI Hackathon. Deadline Oct 30, 2026, 10:00 am PT (10:30 pm IST). Time is the main constraint: prefer simple, working, demoable code over completeness.
- Joy has a Java background and has built a Chrome extension before (tab session saver). Explain browser-extension specifics briefly when they come up.

## Tech constraints
- Chrome extension, **Manifest V3**. Plain TypeScript or JavaScript; keep the build simple (Vite or no bundler).
- **No remotely hosted code** (MV3 rule): bundle every library, including the chart library.
- Storage: IndexedDB for the vault index; `chrome.storage` for settings.
- Saving files: `chrome.downloads` into `Downloads/AI-Vault/...`.
- Nemotron calls go to Nebius Token Factory (OpenAI-compatible `/v1/chat/completions`). User supplies their own API key in the options page (bring-your-own-key). Never commit keys; never log prompt text.
- Model IDs, base URL and prices live in config, not code. Confirm them in the Token Factory console.

## Structure (suggested)
```
manifest.json
src/
  background/        service worker: Token Factory client, alerts, scheduling of Ultra planning
  content/
    sites/claude.ts  one isolated "reader" per site (DOM selectors live only here)
    sites/chatgpt.ts
    overlay/         Evaluate button + recommendation card
    capture/         asset detection, fingerprinting
  dashboard/         extension page: period picker, cards, charts, lists
  options/           API key, plan type, thresholds, sites, save location
  shared/            types, JSON schemas, prompt templates
config/models.json   per-site model catalogue: tier + relative price
bench/               offline validation benchmark (prompts + judge script)
```

## Rules
- Site DOM selectors only inside `content/sites/*`. When a site changes, only that file should break.
- Every Lightning call: reasoning OFF, input capped (~1,000 tokens of user text), strict JSON output validated against the schema in `SPEC.md` §5; on invalid JSON, retry once then fail gracefully.
- Human in the loop: never send a prompt into a chat site on our own. Every send needs an explicit user click on the TokenMileage card ("Apply & send"), and the page side must confirm each requested change (prompt text, model, effort) before pressing send; if any step can't be confirmed, don't send. "Apply" only pre-fills. Background features (next-prompt suggestions) pre-fill only.
- Privacy: send only the minimum excerpt needed; store only summaries/hashes for open loops and repeat detection.
- Log token usage per call (counts only) so the README can report real costs.

## Definition of done for the hackathon
See the checklist in `SPEC.md` §8. Keep `README.md` updated as features land.
