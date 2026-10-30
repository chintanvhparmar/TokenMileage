# TokenMileage: Feedback on Nebius Token Factory and NVIDIA Nemotron

Feedback gathered while building **TokenMileage** (Chrome extension, Nebius x NVIDIA Global AI Hackathon). Each item gives what we saw, the evidence, and what would have helped. Measurements come from our benchmark page (`bench/` in the repo), which calls Token Factory from a Chrome extension page. Items marked **Open** still need more testing before sharing.

## Environment

| | |
|---|---|
| Dates | 2026-10-21 (first integration) and 2026-10-22 (benchmark probe, ~10:10 IST / UTC+5:30) |
| Base URL | `https://api.tokenfactory.us-central1.nebius.com/v1` (alt `https://api.tokenfactory.nebius.com/v1` also tested) |
| Client | Chrome extension page (`fetch` from a Manifest V3 extension), corporate network |
| Models tested | `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B`, `nvidia/Nemotron-3_5-Lightning`, `nvidia/nemotron-3-super-120b-a12b`, `nvidia/Nemotron-3-Ultra-550b-a55b` (18 models visible via `GET /models`) |
| Probe prompt | One-line sentiment classification returning `{"sentiment": ...}`, temperature 0, `max_tokens` 1500. Three runs within 15 minutes (87 calls, all HTTP 200, all valid and correct JSON); timings are indicative, not statistics |

---

## 1. Lightning looks cold-started: very slow on first use, fast once warm

**Severity:** High for interactive use. Lightning is the model we picked for frequent, in-page calls, and every first call of a session is the one a user waits on.

**Benchmark probe, 2026-10-22, three runs (10:10, 10:22, 10:25 IST). Range of time to first token across the 7 streaming probes per model**

| Model | Run 1 (10:10) | Run 2 (10:22) | Run 3 (10:25) |
|---|---|---|---|
| Nano 30B-A3B | 1.0–4.4 s | 1.2–2.6 s | 1.7–2.3 s |
| **Lightning** | **4.9–38.4 s** | **2.4–18.8 s** | **0.6–1.5 s** |
| Super 120B-A12B | 0.63–1.16 s | 0.59–0.93 s | 0.42–1.02 s |
| Ultra 550B-A55B | 0.43–0.77 s | 0.42–0.77 s | 0.41–0.66 s |

**Same request every run: Lightning, streaming, `enable_thinking:false`, 8-token reply**

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Time to first token | 7,325 ms | 2,786 ms | **762 ms** |
| Non-streaming, total | 1,985 ms | 1,123 ms | **554 ms** |

- Lightning got about **10× faster within 15 minutes of steady use**, while Nano, Super and Ultra stayed roughly constant. This looks like scale-to-zero or autoscaling: slow while cold, then comparable to Super and Ultra once warm.
- While cold, the flagship 550B Ultra answered up to **51× faster** than "Lightning" on the same request.
- While cold, streaming was Lightning's slow path: non-streaming calls finished sooner than streaming calls started replying. On 2026-10-21 (first calls of the day) only streaming returned at all (item 2).
- **Possible contributing factor, processing region.** We call `api.tokenfactory.us-central1.nebius.com` (from India). The console cards (2026-10-22) show the two slower models, **Nano and Lightning, processing in eu-north1**, and the two consistently fast ones, **Super and Ultra, in us-central1**. Cross-region forwarding would add a steady delay. It can't explain 38 s, but it may explain why warm Nano and Lightning stay behind Super and Ultra. We don't know how requests are routed, so this is a question rather than a finding.
- **Open:** three runs in 15 minutes show the warm-up but don't prove the cause. Re-probe after Lightning has been idle (mid-afternoon and ~21:00 IST) to see whether it goes cold again.

**Questions for Nebius:** does a public endpoint scale to zero when idle? When a model is processed in another region than the base URL we call, is the request forwarded, and should we call a regional URL instead?

**What would help:** documentation on cold starts and scale-to-zero per model; a keep-warm or minimum-instances option (or guidance on the cheapest way to keep a model warm); published P50/P95 time to first token, warm and cold.

**What would help:** published latency expectations (time to first token, P50/P95) per model, a status or queue indicator, and an explanation of Lightning's positioning if it isn't meant for low-latency calls.

## 2. Non-streaming Lightning calls hung (2026-10-21), but not on re-test

**Severity:** Medium. It was intermittent, but it blocked us for an evening.

| When | Request (`POST /chat/completions`) | Result |
|---|---|---|
| 2026-10-21 ~20:50 IST | Lightning, `stream: false`, `max_tokens: 200` | No response within **60 s** (client abort) |
| 2026-10-21 ~20:52 IST | Lightning, `stream: false`, `max_tokens: 20` | No response within **30 s** |
| 2026-10-21 ~20:52 IST | `Qwen/Qwen3.8-27B`, `stream: false` (same key and network) | HTTP 200 in 582 ms |
| 2026-10-21 ~20:52 IST | Lightning, `stream: true`, `max_tokens: 20` | HTTP 200, first byte 7,879 ms (`chatcmpl-763f5a701abdbbcbdb4c643827f96db2`) |
| 2026-10-22 ~10:10 IST | Lightning, `stream: false`, `max_tokens: 1500` | **HTTP 200 in 1,985 ms** |
| 2026-10-22 ~10:22 IST | same | **HTTP 200 in 1,123 ms** |
| 2026-10-22 ~10:25 IST | same | **HTTP 200 in 554 ms** |

- On re-test, non-streaming worked on all 4 Nemotron models. Together with item 1, this fits a cold Lightning deployment on the first calls of the day. Streaming at least returned headers, while non-streaming gave no signal at all.

**What would help:** a fast, explicit error (e.g. 503 with `Retry-After`) instead of a silent hang when a model is cold or queued.

## 3. Reasoning switch: `enable_thinking:false` works, `/no_think` doesn't, and reasoning is on by default

**Severity:** Medium (cost, latency, JSON reliability). Resolved by measurement; only the documentation is missing.

**Reasoning characters streamed back (`delta.reasoning_content`), same prompt, run 1 / run 2**

| Switch | Nano | Lightning | Super | Ultra |
|---|---|---|---|---|
| none | 171 / 171 | 641 / 597 | 169 / 169 | 219 / 167 |
| `/no_think` system prefix | 171 / 171 | 553 / 553 | 169 / 169 | 167 / 167 |
| `chat_template_kwargs.enable_thinking: false` | **0 / 0** | **0 / 0** | **0 / 0** | **0 / 0** |
| `chat_template_kwargs.enable_thinking: true` | 171 / 171 | 641 / 515 | 171 / 168 | 219 / 219 |

All answers were correct in every row (`{"sentiment": "positive"}`), so turning reasoning off cost nothing in quality on this simple task.

- Reasoning is **on by default** for all four, so a caller who doesn't know about the switch pays for hidden reasoning (8 → 41–185 completion tokens here).
- The `/no_think` convention from earlier Nemotron releases is silently ignored.
- Related: `Qwen/Qwen3.8-27B` with `max_tokens: 20` returned `finish_reason: "length"` with **empty `content`**, because reasoning used up the budget.

**What would help:** document `chat_template_kwargs.enable_thinking` per model on the model card; report reasoning tokens separately in `usage`; reject or warn on switches a model ignores.

## 4. Base URL, model list and pricing discoverability

**Severity:** Low (documentation / API).

- Two base URLs appear in public material. **Both work** (alt URL tested 2026-10-22 with Lightning), but it isn't clear which is canonical or how they relate to the per-model processing region shown in the console.
- Prices and speeds are clear **in the console** but aren't available from the API. The Model endpoints cards show input, cached and output price, Tok/s and the current processing region; the Billing → Prices page lists the same prices. Before we found these, our Lightning price came from a third-party listing. Nemotron prices from the console, 2026-10-22, per 1M tokens:

| Model | Input | Cached input | Output | Tok/s | Region |
|---|---|---|---|---|---|
| Nano 30B-A3B | $0.06 | – | $0.24 | 60 | eu-north1 |
| Lightning | $0.06 | – | $0.24 | 314 | eu-north1 |
| Super 120B-A12B | $0.30 | $0.06 | $0.90 | 127 | us-central1 |
| Ultra 550B-A55B | $1.00 | $0.12 | $3.00 | 523 | us-central1 |
| Super VL (new) | $0.30 | $0.06 | $0.90 | 282 | us-north1 |

- The console's Tok/s figures don't match the time to first token we saw (item 1): Lightning lists 314 Tok/s but was our slowest to start replying. Tok/s alone doesn't tell a developer what an interactive call will feel like.
- **Open:** the console shows **28** public endpoints, while `GET /models` with our key returned **18** models on 2026-10-21. That may just be non-chat models being filtered out, or the list may have changed since; we need to compare the two lists.

**What would help:** price, region and speed fields in `GET /models` (machine-readable, so apps can show real costs); a time-to-first-token figure next to Tok/s; one Quickstart block with the canonical base URL.

## 5. Structured classification quality (Evaluate)

**Severity:** Medium (model behaviour). Seen live with Lightning, reasoning off, temperature 0.

- **Self-contradicting JSON:** for a multi-company stock valuation prompt, Lightning returned `complexity: "complex"` (correct) but recommended the small model with `saving: "medium"` while the user was already on that model. In another run it said `complex` but recommended the medium tier, against an explicit "complex → large" rule.
- **Copying examples word for word:** when the system prompt included sample "good tips", Lightning returned them verbatim for an unrelated prompt.
- **Answering instead of advising:** asked for usage tips about a draft prompt, it sometimes answered the draft instead (e.g. which shell command to use).
- **Tips contradicting its own fields:** it recommended Opus in the JSON while a tip said "Use Sonnet instead of Opus".

### Benchmark: same 10 Evaluate cases on all four Nemotrons (2026-10-22, 10:20–10:42 IST)

The 10 synthetic drafts (`bench/cases.js`) include the live failures above. The identical system prompt goes to every model at temperature 0, with `json_object` mode, streaming, and `max_tokens` 600 with reasoning off or 4,000 with it on. Each output is auto-scored on 10 checks:
- valid JSON matching the schema
- complexity, web search needed and fresh chat matching the expected answer
- model and effort consistent with the stated complexity
- saving consistent with the price ratio
- at most 3 tips, none answering the draft, contradicting the recommendation, or giving formatting advice

| Model | Reasoning | All 10 checks pass | Avg latency | Avg output tokens | Cost / call* |
|---|---|---|---|---|---|
| Nano 30B-A3B | off | 3/10 | 4.4 s | 136 | $0.00011 |
| Nano 30B-A3B | on | 8/10 | 22.5 s | 1,671 | $0.00048 |
| Lightning | off | 4/10 | 7.1 s | 118 | $0.00010 |
| Lightning | on | **2/10** | **71.4 s** | 3,877 | $0.00101 |
| Super 120B-A12B | off | 6/10 | 1.0 s | 95 | $0.00046 |
| Super 120B-A12B | on | 9/10 | 7.6 s | 1,309 | $0.00155 |
| **Ultra 550B-A55B** | **off** | **9/10** | **0.8 s** | 131 | **$0.00163** |
| Ultra 550B-A55B | on | 10/10 | 2.4 s | 655 | $0.00320 |

\*Average 1,235 prompt tokens per call; console prices from item 4. No cached-input discount assumed.

**Findings**
- **Lightning, reasoning off, has the same errors seen live.** Self-inconsistent model choice ("complex" → medium tier) in 4/10 cases, missed fresh-chat calls in 3/10, and one tip that answered the draft ("Add idempotency key to gateway.charge…").
- **Lightning, reasoning on, mostly produced no answer.** In 8/10 cases it streamed ~15,000 characters of reasoning, used ~3,900 of the 4,000-token budget and never emitted the JSON object; 1 more call timed out at 120 s. On a short classification task it doesn't stop thinking.
- **Reasoning fixes most errors in the smaller models, at a latency cost.** Nano went from 3/10 to 8/10 (4 s → 22 s), Super from 6/10 to 9/10 (1 s → 8 s).
- **Ultra needs no reasoning for this task.** 9/10 with reasoning off at 0.8 s; its single miss was a debatable fresh-chat call on a draft that referred back to the conversation. No Ultra output answered the draft or contradicted itself.
- JSON validity was 10/10 for every model with reasoning off. Format compliance isn't the problem; cross-field reasoning is.

**Caveats:** 10 cases, one run each, expected labels written by us, and some checks are strict (e.g. "ask for a concise bullet summary" counts as a formatting tip). The ranking is clear; the exact percentages aren't statistics.

**What would help:** guidance on which Nemotron to use for short structured classification (our results contradict the "Lightning for fast, frequent calls" positioning), and a reasoning budget parameter (e.g. max reasoning tokens) so reasoning-on runs can't use up the whole output budget.

### Follow-up: Ultra live on claude.ai, then a prompt fix (2026-10-24)

Live, with Ultra and reasoning off, a user already on Haiku typed "command to list files" in a new chat. The card said "Saving: high" (the only change was lowering effort from medium to low) and gave the tip "Keep chat short; avoid re-reading long history" for a chat with 0 turns. Both are cross-field errors of the same kind as above, only rarer.

We changed only the system prompt:
- the saving follows the current-to-recommended price ratio and is "none" or "low" when the model stays the same
- no new-chat or history tips unless `fresh_chat` is true

We also added this case and a `tipsMatchThread` check to the benchmark. Re-scoring the 2026-10-22 run with that check, it fails 1/10 for Ultra off, 6/10 for Lightning off and 0/10 for Super off.

| Ultra, reasoning off | All checks pass | Avg latency |
|---|---|---|
| Before (2026-10-22, 10 cases, new check applied) | 8/10 | 0.8 s |
| After prompt fix (2026-10-24, 11 cases) | **10/11** | 1.2 s |

The live case is now correct: saving "low" and one tip, "Use low effort for simple commands". The remaining miss is `debug-race`, with the tip "Thread is short and on-topic; keeping history avoids re-explaining the bug". It's harmless advice, but it ignores the instruction not to write tips about what the user doesn't need to do. Explicit negative rules in the system prompt fixed most cross-field errors with no change of model.

### Follow-up: prompt rewriting in the same call (2026-10-24)

Evaluate now also returns `revised_prompt`: the user's draft rewritten for the recommended model. It must keep the user's intent and pasted data, never answer the draft, and stay empty if the draft is already clear. Three benchmark runs on Ultra (11 cases each):

| Run | Ultra reasoning | All checks pass | Median latency | Avg output tokens | Cost / call* |
|---|---|---|---|---|---|
| 1. First rewrite rules | off | 8/11 | 1.3 s | 187 | $0.0021 |
| 2. Tightened rules | off | **10/11** | **1.2 s** | 182 | **$0.0021** |
| 2. Tightened rules | on | 11/11 | 3.5 s | 893 | $0.0043 |

\*Average 1,512 (run 1) and 1,585 (run 2) prompt tokens per call; the tighter rules made the system prompt longer.

**What went wrong in run 1, with reasoning off.** All five problems were found by reading every rewrite, not by the original checks, so new checks were added and verified against the saved run 1 output:
- **Guessed a detail the user left open:** "command to list files" became "…on Linux/macOS". The test user was on Windows.
- **Changed the scope:** "all AI stocks" became "the top 10", and one rewrite invented "exclude companies where AI is a minor segment".
- **Leaked the answer into the prompt:** the race-condition draft got "…using database constraints or distributed locking", and the schema draft got its own table list and trade-offs.

**What fixed it.** Three explicit rules, with no model change:
- keep the scope exactly
- never choose open details; ask for the common options instead
- describe the deliverable, never its content

With reasoning off, run 2 has none of these problems. The one remaining miss is the known filler tip ("Current thread context is relevant").

**Reasoning on** was also clean (11/11) and more conservative: it left already-clear drafts alone instead of adding "Answer in one sentence". But it costs 2× and is about 3× slower. We keep reasoning off.

**Takeaway for Nemotron users:** for generation tasks, Ultra with reasoning off follows explicit "never do X" rules reliably, but it doesn't infer them. A positive instruction like "invent nothing" wasn't enough; it needed the specific failure named ("no top N", "no OS").

### Follow-up: two more cases, and run-to-run variation (2026-10-27)

We added two cases: `time-now`, seen live ("what time it is" was rewritten as "…in UTC?"), and `powerbi-plan` (a one-line draft in a new chat). Ultra with reasoning off was run twice on the 13 cases, with one prompt line changed in between:

| Run | All checks pass | Median latency | Misses |
|---|---|---|---|
| 1 | 11/13 | 2.0 s | `powerbi-plan`: recommended a fresh chat *in a new chat* ("New chat avoids empty history cost"); `debug-race`: the known filler tip |
| 2, after adding "fresh_chat is always false when thread.turns is 0" | 11/13 | 2.5 s | `powerbi-plan` fixed; `stocks-on-haiku`: the rewrite listed which sectors count as "AI"; `debug-race` |
| 3, after adding "don't spell out what the scope includes"† | 11/13 | 1.5 s | `stocks-on-haiku` fixed; `news-today`: tip "Ask for brief bullet list to save tokens" (a format tip, counted as a miss by our strict check); `debug-race` |

| 4, same prompt as run 3 | **12/13** | 1.3 s | only `debug-race` |

†Run 3 was accidentally started twice, so 7 cases ran twice. Both copies of every case gave the same pass or fail.

- **Explicit rules work, again.** Adding "time zone, location, currency…" to the list of open details fixed `time-now`. The rewrite now asks the assistant to state the zone it used. The new-chat line fixed `powerbi-plan`.
- **Output changes between runs at temperature 0.** `stocks-on-haiku` passed in run 1 and failed in run 2. The only prompt change was an unrelated line, so a small change elsewhere in the prompt can flip a borderline case. We named this failure too ("don't spell out what the scope includes"), which fixed it in run 3, and keep a code guard for the impossible case, no fresh chat in a new chat.
- **We stopped tuning at 11–12/13.** Run 4, with run 3's prompt unchanged, gave 12/13; the `news-today` format tip didn't recur. Every run has had one or two borderline misses, and each fix tends to move a different borderline case. The remaining misses are harmless tips, not wrong models, invented scope or leaked answers. Chasing them further would make the prompt longer for little gain.

**Supported, to try next:** strict `response_format: json_schema` was accepted by all 4 models in the probe. Enums in the schema would make invalid values impossible, though not cross-field contradictions.

## 6. Tool calling (agent with Tavily search/extract tools)

**Severity:** Positive finding, plus guidance needed on model choice. Non-streaming, reasoning off (`enable_thinking:false`), temperature 0, OpenAI-style `tools` with `tool_choice: "auto"`, then `"none"` once the budget is used.

TokenMileage researches each model in the user's claude.ai picker: Nemotron gets `tavily_search` and `tavily_extract` tools and returns strict JSON (best uses, API price, size, sources). Code then checks every fact against the fetched text. The benchmark ran all four Nemotrons on 11 real models, as an agent and as a fixed pipeline where code does the search and extract and Nemotron only reads (88 runs, 2026-10-27). Raw file: `bench/results/tokenmileage-bench-2026-10-27T14-39-17-092Z.json`.

| Nemotron | Prices consistent* (agent / pipeline) | Own tool calls | Tokens / model (agent) | Cost / model (agent) | Avg time (agent) |
|---|---|---|---|---|---|
| Nano 30B-A3B | 9/10 / 9/10 | 1.1 | 6.3k | $0.0004 | 7.3 s |
| Lightning | 10/10 / 8/10 | 3.0 (always the maximum) | 17.2k | $0.0011 | 12.0 s |
| **Super 120B-A12B** | **10/10 / 10/10** | 1.0 | 7.1k | $0.0023 | **3.8 s** |
| Ultra 550B-A55B | 10/10 / 10/10 | 2.1 | 12.4k | $0.0130 | 7.5 s |

\*Equal to the most common price found for that model across all runs; the majority matches Anthropic's known prices where we know them.

**Findings**
- **Tool calling worked on all four models through Token Factory**: valid `tool_calls`, correct argument JSON, the `tool` role handled, and `tool_choice: "none"` respected. None of the 88 runs needed the fallback.
- **Super is the sweet spot for tool use.** It was as accurate as Ultra, with the fewest Tavily calls, about half Ultra's time and about a fifth of its cost.
- **Lightning over-uses tools.** It always used the whole budget (3 extra calls), with filler queries built from the schema's words ("size class small medium large lineup"). That made it the slowest at 12 s and used the most tokens.
- **The small models pick the wrong row from a table.** Nano and the Lightning pipeline reported $10/$37.50 for Opus 4.6 (apparently a long-context row) and $0.01/$0.05 for Haiku 5.5.
- **The small models copy the prompt's examples**, as in item 5. Nano returned the system prompt's example phrases as a model's best uses in 4/11 runs (e.g. "fast simple tasks" for Opus 4.8). Super and Ultra did this 0 times.

**What would help:** guidance per task type would help. Our two benchmarks give opposite answers to "which Nemotron for frequent calls": Ultra for short structured classification (item 5) and Super for tool use (this item). Lightning is positioned for fast, frequent calls, but it was the slowest in both.

---

## What worked well

- OpenAI-compatible API: our client is a plain `fetch` with no SDK, which is ideal inside a Manifest V3 extension (no remote code allowed).
- `GET /models` is fast and makes a free, zero-token "test connection" button possible.
- Streaming with `stream_options: {include_usage: true}` gives real token counts per call, plus time to first token.
- Strict JSON-schema output is accepted on all 4 Nemotron models.
- OpenAI-style tool calling works on all 4 Nemotron models with no special handling (item 6).
- Super and Ultra are impressively fast (sub-second time to first token).
- A good range of NVIDIA open models on one key makes it easy to pick a model per task.

## Before sharing

- [x] Re-test non-streaming (item 2): not reproduced on 2026-10-22
- [x] Measure time to first token across Nemotron models (item 1)
- [x] Confirm the reasoning-off switch (item 3)
- [x] Alternative base URL (item 4): works
- [x] Evaluate quality benchmark results (item 5), raw file `tokenmileage-bench-2026-10-22T05-12-47-011Z.json`
- [ ] Re-run the quality benchmark once more to check the ranking is stable
- [ ] Re-probe after idle periods (mid-afternoon, ~21:00 IST) to test the cold-start explanation (item 1)
- [ ] Compare the console's 28 public endpoints with today's `GET /models` list (item 4)
- [ ] Check that no API keys, names or internal URLs are in this document
