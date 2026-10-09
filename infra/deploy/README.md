# Deploy — GameForge AI Studio backend (Oracle Cloud Linux)

Docker Compose stack for the server side. The frontend (Vercel) is separate;
see the root README and `docs/ARCHITECTURE.md` §9.

## Services

| Service | Image / build | Role | Public? |
|---|---|---|---|
| `reverse-proxy` | `caddy:2-alpine` | TLS + two-origin routing (app vs preview) | 80/443 |
| `api` | `Dockerfile.api` | Fastify `/api/v1`, SSE, migrations at boot | no |
| `worker` | `Dockerfile.worker` | BullMQ: agent runs, builds, verification | no |
| `runner` | `Dockerfile.runner` | **Spawn gate** — the only Docker-socket holder | no |
| `postgres` | `postgres:16-bookworm` | Durable state | no |
| `redis` | `redis:7-bookworm` | Queues (AOF persistence) | no |

## The socket mount (read this)

`runner` mounts `/var/run/docker.sock`. This is the **single privileged spawn
gate** — the Genex-`ProcessSandbox` analogue. Consequences, all deliberate:

- `api` and `worker` **never** get the socket. They call the runner library
  (HTTP binding in Phase 3); they cannot spawn containers themselves.
- The runner *service* runs as root so it can talk to the socket. Every
  *workload* container it spawns runs as `65532:65532` with `--cap-drop=ALL`,
  `--read-only`, `--network none` (or the `gf-egress` proxy network),
  `--pids-limit`, memory/CPU quotas and a 1024-fd ulimit. See
  `apps/runner/src/runner.ts` — the argv is the contract.
- Putting containers on one compose network is **not** treated as a security
  boundary (the compose file says so too). The boundary is the spawn gate.

## First boot

```bash
cd infra/deploy
cp .env.example .env
# edit .env: GF_DOMAIN, GF_ACME_EMAIL, ALLOWED_ORIGINS, POSTGRES_PASSWORD, CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
bash ../../scripts/init.sh     # checks docker, creates STORAGE_ROOT, pre-pulls images
docker compose up -d --build
docker compose exec runner node apps/runner/dist/service.js --check  # expect: docker: available
curl -k https://$GF_DOMAIN/api/v1/health
```

`init.sh` also creates the `gf-egress` Docker network. The egress *proxy*
(allowlist: npm registry + Playwright CDN only) is wired in Phase 7; until then,
`registry-only` jobs fail closed if the network is missing.

## Updating

```bash
bash ../../scripts/update.sh   # git pull → build → migrate (api runs migrations at boot) → up
```

## Backups

Nightly `pg_dump` + `restic` of `STORAGE_ROOT` — see `docs/DATABASE.md` §4.
Restore drill is part of Phase 7 acceptance.

## Resource defaults

api 1 CPU/1G · worker 2 CPU/2G · runner 4 CPU/4G · postgres 1 CPU/1G ·
redis 0.5 CPU/512M · proxy 0.5 CPU/256M. Tune in `docker-compose.yml`
(`deploy.resources`) after measuring on the real Oracle instance (R1).

## Honest gaps (Phase 7)

- Egress proxy for `gf-egress` (registry-only jobs).
- Runner HTTP binding (currently `service.js` idles; `--check` works now).
- `preview.` origin backend (`api:8091` page server) — Caddy routes it, the API
  serves it in Phase 3.
- Worker health: no fake HTTP healthcheck; use `GET /api/v1/system/metrics`
  (BullMQ heartbeat).
