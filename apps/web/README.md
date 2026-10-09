# gameforge-web — GameForge AI Studio frontend

Vite + React 19 + TypeScript SPA. Deploys to Vercel. The control surface only:
durable state lives in Postgres on the Oracle backend; **localStorage is never
authoritative** (theme, language and view prefs only).

## Run

```bash
npm install          # from the repo root (npm workspaces)
npm run dev          # vite dev server on :5173, /api proxied to :8090
npm run typecheck
npm run test         # vitest
npm run build        # tsc + vite build → dist/
```

## Env vars

| Var | Default | Notes |
|---|---|---|
| `VITE_API_URL` | `http://127.0.0.1:8090` | Backend base URL. Placeholder only — **never a secret**. |

Build-time rule: no secret-shaped values in the client bundle (Cloudflare token, Oracle
credentials). The browser holds no API keys by design.

## Routes

| Route | Page |
|---|---|
| `/` | Dashboard — project cards, new-project dialog, empty/loading/error states |
| `/projects/:id` | Studio — left nav, central chat, right tabs (Preview / Builds / Code / Console) |
| `/projects/:id/assets` | Assets — read-only asset grid (kind filters, use-stage badges) |
| `/projects/:id/builds` | Builds — build timeline + detail drawer (verdict, pipeline phases, preview link) |
| `/settings` | Settings — theme, language, backend info, model-per-role bindings |

## i18n

- `src/i18n/en.json` (default) + `src/i18n/es.json`. **Every UI string goes through
  `t()`** — no hardcoded user-facing English outside `en.json`.
- **Parity rule:** both dictionaries must have identical key sets. Enforced by
  `src/test/i18n.test.ts` (fails CI if a key is missing in either language).

## PWA

`vite-plugin-pwa`, `registerType: 'prompt'` — safe updates: the user is asked via
`UpdatePrompt`; we **never force-reload** (a reload mid-run would drop SSE state).
Manifest icons are original geometric artwork (`public/icons/`), not Genex branding.

## SSE

`src/api/sse.ts` — `useRunEvents(runId, onEvent)`:
native `EventSource` → `/api/v1/runs/:id/events`, tracks the stable `Last-Event-ID`
(`agent_events.seq`), reconnects with exponential backoff (1s → 30s) and passes
`?lastEventId=` so the server replays missed events. The running job survives
browser loss; the server journal is authoritative.

## No-dead-buttons audit (Phase 5 build)

**Principle:** every rendered control works against a real backend endpoint, or it
doesn't render. Where the backend contract assumed by an earlier plan doesn't
exist yet, the UI degrades to honest read-only views — never to buttons that
fake success.

- **Assets page** (`/projects/:id/assets`): full upload/delete/list backed by the
  real endpoints — multipart `POST /projects/:id/assets` (201, kind inferred from
  the extension or set explicitly, 10 MiB cap, hostile filenames sanitized),
  two-step `DELETE /assets/:id` (204 + file removed), and per-asset download via
  `GET /assets/:id/download` (containment-jailed). No per-asset thumbnails: the
  list response carries no preview URL, so kind icons render instead (documented,
  not faked). AI generation stays unrendered (Phase 6; `POST /assets/generations`
  is 501).
- **Builds page** (`/projects/:id/builds`): timeline + detail drawer backed by
  `GET /projects/:id/builds` and `GET /builds/:id`. The drawer shows the verdict
  summary, the pipeline phase list from `verdict.phases` (persisted by the
  worker), plus live diagnostics: test results (`GET /builds/:id/tests`), review
  results (`GET /builds/:id/reviews`), and artifacts with real downloads (`GET
  /builds/:id/artifacts` → `GET /artifacts/:id/download`, containment-jailed).
- **Revisions page** (`/projects/:id/revisions`): paginated newest-first list from
  `GET /projects/:id/revisions` — sha, health badge, checkpoint kind, author,
  message. Linked from the Studio sidebar and the mobile "More" tab.
- **Settings page** (`/settings`): theme + language reuse the local store (same
  controls as the header). API URL is read-only display of `VITE_API_URL`.
  The model-per-role table is real: roles from `GET /models/capabilities`,
  bindings from `GET /settings` (`modelByRole`), model names from `GET
  /models`, edits persisted via `PATCH /settings` (secret-like keys are refused
  server-side). If the backends are unreachable the page shows an honest error,
  never a fake table.
- Studio sidebar now shows **Dashboard / Projects / Create Game / Assets /
  Builds / Revisions / Settings**. Plugins and Studio Memory stay omitted (backend UI
  planned Phase 6) — an omitted entry can't be mistaken for a broken one.
- Preview iframe renders only when a build exposes `preview_url`; otherwise an
  empty state. Reload / open-standalone render only with a live URL.
- Question cards answer by sending a normal chat message (no separate answer
  endpoint exists in v1) — wired and working, not decorative.
- Mobile: the Studio 3-pane grid collapses to a tab bar (Chat / Preview /
  Builds / Code / **More**) under 1024px; "More" links to Assets, Builds and
  Settings. The header settings gear is reachable on all viewports. Touch
  targets are ≥44px on mobile; the model table scrolls inside its own container
  instead of pushing the page sideways.

## Accessibility

Semantic landmarks (`header`/`nav`/`main`/`section`), `aria-label`s on icon buttons,
visible `:focus-visible` rings, `prefers-reduced-motion` respected, `/` focuses the
composer, `Esc` closes dialogs.

## What's Phase 6 (not here)

Plugin panels, Studio Memory UI, AI asset generation, build graph, Activity /
diagnostics dashboards, terminal.
