# @gameforge/model-providers

Groq Cloud LLM adapter for GameForge AI Studio: typed client, live capability
registry, per-run budgets, and token cost accounting.

## Environment

| Variable       | Required | Notes                                                        |
| -------------- | -------- | ------------------------------------------------------------ |
| `GROQ_API_KEY` | yes      | **Server-only.** Never in client bundles, logs, or errors.   |
| `GROQ_BASE_URL`| no       | Default `https://api.groq.com/openai/v1`.                    |

The key is registered with the shared secret redactor at client construction;
every error string is redacted before it is built. The key travels only in the
`Authorization` header.

## The no-hardcoded-models rule

No selection logic names a model. `ModelRegistry.selectModel()` filters purely
on capabilities (`supports_tools`, `supports_vision`, `supports_json_mode`,
`context_window`). Capability *data* lives in a date-stamped curated table
(`CURATED_CAPABILITIES_AS_OF = '2026-10-09'`) that must be re-verified against
Groq docs — Groq retires models. Models absent from the table get conservative
defaults (no tools, no vision) unless the opt-in `probeToolSupport()` verifies
otherwise. Probing costs tokens and is never run by `refresh()`.

## Price-table dating policy

`PRICES` rows each carry `asOf`. Re-verify against https://groq.com/pricing
before relying on them. `computeCost()` returns `null` for unlisted models —
unknown prices are reported as unavailable, **never guessed** (Genex evals
discipline).

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

## What degrades when Groq is unreachable

- `refresh()` throws `NETWORK_ERROR`/`TIMEOUT` (retryable) — the API surfaces
  this as `503 DEPENDENCY_UNAVAILABLE`; runs stay `queued`, never half-planned.
- `selectModel()` on an empty registry throws `MODEL_UNAVAILABLE` naming the
  missing capability; the UI shows the limitation instead of a dead button.
- Budgets keep working offline (they only need recorded usage).

## Verification status

- Unit tests: mocked `fetch` only — **no real network**. Run with
  `npx vitest run` in this package.
- This dev VM has no Docker/Postgres/Redis; live Groq verification happens on
  Oracle in Phase 7 (opt-in real-AI acceptance with the user's key).
