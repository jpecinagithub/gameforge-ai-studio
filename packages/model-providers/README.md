# @gameforge/model-providers

Cloudflare Workers AI adapter for GameForge AI Studio: typed client, live capability
registry, per-run budgets, and neuron/token usage accounting.

## Environment

| Variable                | Required | Notes                                                        |
| ----------------------- | -------- | ------------------------------------------------------------ |
| `CLOUDFLARE_API_TOKEN`  | yes      | **Server-only.** Never in client bundles, logs, or errors.   |
| `CLOUDFLARE_ACCOUNT_ID` | yes      | From the Cloudflare dashboard URL or Workers & Pages overview. |

The token is registered with the shared secret redactor at client construction;
every error string is redacted before it is built. The token travels only in the
`Authorization: Bearer` header.

## The no-hardcoded-models rule

No selection logic names a model. `ModelRegistry.selectModel()` filters purely
on capabilities (`supports_tools`, `supports_vision`, `supports_json_mode`,
`context_window`). Capability *data* lives in a date-stamped curated table
(`CURATED_CAPABILITIES_AS_OF = '2026-10-09'`) that must be re-verified against
the live account catalog — Cloudflare changes the model list. Models absent from the table get conservative
defaults (no tools, no vision) unless the opt-in `probeToolSupport()` verifies
otherwise. Probing costs neurons and is never run by `refresh()`.

## Pricing policy

Workers AI bills in **neurons** (10,000 free/day per account). Exact pricing
lives in the Cloudflare dashboard — this package carries **no price table**
and `computeCost()` always returns `null`: prices are **never guessed**
(Genex evals discipline). Usage accounting (tokens, latency, neurons) is
recorded honestly; cost conversion happens only against dashboard-verified
prices, outside this package.

## Resilience

- Exponential backoff with full jitter; bounded retries (default 4) **only** on
  429 / 5xx / network errors / timeouts. Other 4xx throw immediately, typed.
- Per-request timeout (default 120s) via a hard race — hangs are impossible even
  if the fetch implementation ignores abort signals.
- Malformed tool-call arguments throw typed `BAD_RESPONSE`; they are never
  silently coerced (a string-typed `arguments` bug once killed tool-calling
  tasks in production — see AGENT JOB ops notes).
- `BudgetTracker` enforces per-run token / cost / wall-clock limits with typed
  `BudgetExhaustedError` naming the broken budget.

## What degrades when Cloudflare is unreachable

- `refresh()` throws `NETWORK_ERROR`/`TIMEOUT` (retryable) — the API surfaces
  this as `503 DEPENDENCY_UNAVAILABLE`; runs stay `queued`, never half-planned.
- `selectModel()` on an empty registry throws `MODEL_UNAVAILABLE` naming the
  missing capability; the UI shows the limitation instead of a dead button.
- Budgets keep working offline (they only need recorded usage).

## Verification status

- Unit tests: mocked `fetch` only — **no real network**. Run with
  `npx vitest run` in this package.
- This dev VM has no Docker/Postgres/Redis; live Cloudflare verification happens on
  Oracle (opt-in real-AI acceptance with the user's credentials).
