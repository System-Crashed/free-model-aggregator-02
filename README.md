# free-model-aggregator-02

One server that serves the OpenAI Chat Completions API and the Anthropic
Messages API over the free OpenRouter models, live through the grader's
gateway, in JSON and in server-sent events, and registers the catalog it
read from the brief.

## What it does

- Reads the trial brief (`$MAKEFUN_PROMPT_FILE`): the free model list and
  the six-prompt manifest.
- Routes every request by its own requirements — never by prompt id, because
  the JSON-mode prompts move between trials — ranking the free models that
  meet them by the brief's `rating_milli`, best first:
  - JSON-required → `openrouter/nvidia/nemotron-3.5-super-vl:free` (1303,
    best JSON-capable).
  - Everything else → `openrouter/thinkingmachines/inkling-2-small:free`
    (1475, best overall; `json=false`, so never for JSON).
  - Fallback is pure rating order: Super-VL (1303) → Nemotron 3 Ultra
    (1285) → 3.5 Lightning (1221) → Gemma 4 31B (1210) → the 1150s.
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

## Score math (trial-0 weights, verified against the kit's scorer + reference)

- Clean run (inkling + Super-VL): quality 100 → score 100 if every other
  column is perfect, 6 gateway calls.
- Inkling dead (Super-VL fallback for non-JSON): quality 91.25 → score
  94.75 → **95**, beating the leaderboard's top tie (94). The Ultra-only
  fallback the earlier plan assumed would give quality 90.34 → score 94.
  So the pure rating order is strictly better than the Ultra-first chain —
  *if* Super-VL answers plain-text prompts live, which is still unproven.
- The whole bounty still hinges on the live test: does inkling-2-small
  actually answer through the gateway? Nobody on the leaderboard is above
  quality 90, which suggests it rate-limits or refuses live.

## Files

- `main.ts` — the server: brief, catalog, routing, failover, wires,
  register and poll.
- `lib/providers.ts` — the brief's types and parser, the free model list,
  the catalog.
- `lib/wire.ts` — the client wires and the gateway wire: Anthropic and
  OpenAI translation both ways, and the SSE writers.
- `LICENSE` — MIT.

## Local verification (2026-11-16, no OpenRouter key yet)

Stub end-to-end test (`/tmp/agg02-stub-test.mjs`, fake env + fake gateway
on localhost, trial-0 brief) — all three scenarios pass:

| scenario | result |
|----------|--------|
| clean | 6/6 served 200, 6 gateway calls, Super-VL on the 2 JSON prompts, inkling on the other 4 |
| failover (inkling 429s) | 6/6 served 200, inkling called exactly twice then exhausted, rest served by Super-VL, `x-makefun-upstream-failures` carries both 429 rows (`rate_limited`) |
| unauthorized (401) | 6/6 answered 502, exactly 6 gateway calls (one per prompt, no failover waste) |

`node main.ts --list` is byte-identical to the starter's on all three
practice trials (14 models).

## Still to do (needs the OpenRouter key)

1. Push the key to the competition (never into the repo — a pushed key
   value in any commit/file is refused as `committed_secret`).
2. One direct live inkling call, then `grade-local` practice trials 0–2
   (`--driver process`); submit only if quality > 90 holds live.
3. The user still has to create the public repo for this entry (the -01
   repo pattern: `free-model-aggregator-02` under System-Crashed) — the
   entry here is not yet committed or pushed anywhere.
