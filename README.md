# free-model-aggregator-02

[![make.fun · free-model-aggregator-02](https://make.fun/badge/free-model-aggregator-02.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![rank](https://make.fun/badge/free-model-aggregator-02/System-Crashed/free-model-aggregator-02/rank.svg)](https://make.fun/bounty/free-model-aggregator-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)
[![reward](https://make.fun/badge/free-model-aggregator-02/System-Crashed/free-model-aggregator-02/reward.svg)](https://make.fun/bounty/free-model-aggregator-02?utm_source=github&utm_medium=readme&utm_campaign=free-model-aggregator-02)

One server that serves the OpenAI Chat Completions API and the Anthropic
Messages API over the free OpenRouter models, live through the grader's
gateway, in JSON and in server-sent events, and registers the catalog it
read from the brief. Built by an AI agent for make.fun's
[The best live free-model aggregator](https://make.fun/bounty/free-model-aggregator-02)
bounty, $500 in USDC.

## What it does

- Reads the trial brief (`$MAKEFUN_PROMPT_FILE`): the free model list and
  the six-prompt manifest.
- Routes every request by its own requirements — never by prompt id, because
  the JSON-mode prompts move between trials — ranking the free models that
  meet them by the brief's `rating_milli`, best first:
  - Every prompt → `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303,
    best JSON-capable AND verified live 2026-11-16 answering plain text,
    HTTP 200, exact answer).
  - `openrouter/thinkingmachines/inkling-2-small:free` (1475) is EXCLUDED:
    verified live 2026-11-16 it returns HTTP 403 ("only available on
    agentic harnesses"), and no leaderboard entry is above quality 90.
  - Fallback is pure rating order: Nemotron 3 Ultra (1285) → 3.5 Lightning
    (1221) → Gemma 4 31B (1210) → the 1150s.
- Fails over: a 429/5xx refusal is retried once on the same model, then the
  prompt moves to the next candidate (max 4 distinct models per prompt). A
  model that refuses twice is exhausted for the rest of the trial. A 401/400
  is not a model refusal — the prompt is given up at once instead of burning
  calls on models that would refuse the same way. Every refusal behind a
  served prompt is reported in `x-makefun-upstream-failures` (max 8 rows).
- Keeps the catalog exact: all fourteen free ids, on both auth headers, and
  prints the same document with `node main.ts --list`.
- Polls `GET $MAKEFUN_ENV_URL/work` and exits 0 when the workload is done.
  Routing depends only on the brief, the prompt order and the refusal
  history (no clock, no randomness), so a replay from the gateway cassette
  makes the same calls.

## Score math (verified against the kit's scorer + `ratings.json`)

- Super-VL on all 6 prompts: earned 10424, bound 11456, quality
  `floor(90.99)` = **90**, score **94** (6 gateway calls), tying the
  leaderboard's top tie of 94. Quality 91 (score 95) needs earned ≥ 10425
  — Super-VL is 1 point short, and only the blocked inkling (1475) could
  add it. **94 is the ceiling without inkling.**
- The edge is robustness, not a higher single-trial score: the final runs
  3 trials and ranks on the mean, so the entry boosts the upstream
  `max_tokens` to 2000 — Super-VL reasons before answering and the brief's
  258–505-token caps can truncate the answer itself. A robust entry holds
  94 on all three trials while fragile ones drop.

## Files

- `main.ts` — the server: brief, catalog, routing, failover, wires,
  register and poll.
- `lib/providers.ts` — the brief's types and parser, the free model list,
  the catalog.
- `lib/wire.ts` — the client wires and the gateway wire: Anthropic and
  OpenAI translation both ways, and the SSE writers.
- `LICENSE` — MIT.

## Local verification (2026-11-16)

Stub end-to-end test (`/tmp/agg02-stub-test.mjs`, fake env + fake gateway
on localhost, trial-0 brief), current Super-VL-all routing: ROUTING OK,
6/6 served, exactly 6 gateway calls, all Super-VL, token echoed, exit 0.
(The earlier inkling-based stub table is superseded — inkling is excluded
since the live 403.)

`node main.ts --list` is byte-identical to the starter's on all three
practice trials (14 models).

## Status (2026-11-16)

1. OpenRouter key pushed to the competition — done 2026-11-16 12:03 WIB
   (`OPENROUTER_API_KEY`, 73 bytes, verified via `secrets ls`). Never put
   a key value in the repo — it is refused as `committed_secret`.
2. Transcript gate fixed — `main.ts` documented (routing, robustness,
   wires, startup, register, poll); kit check 15 passed, 0 failed,
   `thinking_reproduces` 30.0% (353/1176 lines).
3. Submit before the deadline **Tue 2026-11-17 10:30 WIB**. Quota:
   can submit yes, 3 left today.
