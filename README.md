# GameForge AI Studio

A complete, production-grade, web-based AI game development studio inspired by the
open-source [Genex Desktop](https://github.com/genex-games/genex-desktop) application
(MIT, © 2026 genex.games — see `docs/REFERENCE_ANALYSIS.md` §0 for license/brand
boundaries). Original implementation, original visual identity.

One user describes a game in natural language; coordinated AI agents create, modify,
compile, test, preview, improve and export a real working browser game.

## Repository layout

| Path | Contents |
|---|---|
| `apps/web` | Vite + React + TypeScript frontend (Vercel, PWA, EN/ES, dark default) |
| `apps/api` | Fastify REST API (`/api/v1`), OpenAPI, SSE |
| `apps/worker` | BullMQ workers: agent runs, builds, verification, Blender, plugins |
| `packages/shared` | Typed contracts (API, events, tool schemas), zod validators |
| `packages/agent-core` | Orchestrator: roles, modes, tool loop, judges, memory |
| `packages/game-templates` | 8 functional starter templates (three.js primary) |
| `packages/plugin-sdk` | Plugin manifest SDK + host-service bridge |
| `packages/model-providers` | Cloudflare Workers AI adapter, capability registry, budgets, backoff |
| `packages/test-runner` | Build/test/evidence pipeline (Playwright, `window.__studio`) |
| `infra/db/migrations` | Versioned PostgreSQL migrations |
| `infra/deploy` | Docker Compose, systemd units, reverse-proxy config |
| `scripts` | Init, update, backup, restore scripts |
| `docs` | `REFERENCE_ANALYSIS.md`, `ARCHITECTURE.md`, `DATABASE.md`, `THREAT_MODEL.md` |
| `tests` | Cross-package integration + E2E tests |

## Docs

- [docs/REFERENCE_ANALYSIS.md](docs/REFERENCE_ANALYSIS.md) — Genex reverse-engineering,
  feature-by-feature comparison (Phase 1)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — system architecture (Phase 1)
- [docs/DATABASE.md](docs/DATABASE.md) — PostgreSQL schema design (Phase 1)
- [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md) — threat model + residual risks (Phase 1)
- [FEATURE_MATRIX.md](FEATURE_MATRIX.md) — every requirement, honestly statused

## Status

Phase 1 (research + architecture) complete. See `FEATURE_MATRIX.md` for the
phase-by-phase build plan. No fake features: a requirement moves from "not
implemented" only when its acceptance check passes.
