# gameforge-runner

Isolated container execution for GameForge AI Studio — the **single privileged spawn
gate** for untrusted code.

This is the direct analogue of Genex's `ProcessSandbox` living in trusted Electron
main (MIT): exactly one component in the system is allowed to touch the Docker
socket/CLI. The API, the workers and the orchestrator call this library; nothing else
spawns containers.

## The one privileged component

In `infra/deploy/docker-compose.yml` the `runner` service is the **only** service with
`/var/run/docker.sock` mounted. `api` and `worker` never get the socket. The socket
mount is the spawn gate — documented with a big comment in the compose file.

## Hard rules

1. **No host execution of untrusted code. Ever.** If Docker is unavailable,
   `runJob` throws `RunnerError` with code `runner_unavailable` (maps to shared
   `ApiErrorCode.RUNNER_UNAVAILABLE`). There is deliberately no fallback.
2. **Explicit argv arrays.** `docker run` is built as an argv list passed to
   `child_process.spawn`. No shell, no string interpolation, no `--env-file`.
3. **Pinned image allowlist** (`images.ts`): one exact `name:tag` list per
   capability (`edit`/`install`/`build`/`test`/`publish`/`delete`). Anything else is
   refused. `--pull never`: images are pre-pulled at deploy; a job can never trigger
   a surprise pull. Update pins deliberately — bump, verify green, commit.
4. **Default-deny everything**: `--user 65532:65532` (non-root), `--read-only`
   rootfs, `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--network none`
   (or the `gf-egress` proxy network for `registry-only`), `--pids-limit`,
   `--memory` + `--memory-swap` equal, `--ulimit nofile=1024:1024`.
5. **One mount**: the job's own workdir at `/work` (rw). Nothing else — no host
   secrets, no socket, no Postgres/Redis networks, no cloud metadata.
6. **Env allowlist** (`sanitize.ts`): only safe keys (`PATH`, `HOME`, `LANG`, …)
   plus `GF_*` job vars pass. Credential-shaped names (`*KEY*`, `*TOKEN*`,
   `*SECRET*`, `*PASSWORD*`, `*DSN*`, `*AUTH*`) are stripped even if allowlisted.
7. **Path containment**: the workdir must resolve (realpath, symlinks followed)
   inside `RUNNER_WORK_ROOT`. Symlink escapes are refused.
8. **Timeouts kill the container, not just the client**: on timeout we
   `docker kill <name>` first (killing the CLI client does not stop the container),
   then SIGKILL the client. `timedOut: true` is reported.
9. **Per-run logs**: `${RUNNER_LOG_ROOT}/<jobId>.log` (0600) with the redacted spec,
   both streams and the result. Logging is best-effort and can never fail the job.
   All log content passes through the shared secret redactor.

## Capability table

| Capability | Image(s) | /tmp | Network |
|---|---|---|---|
| `edit` | node:22-bookworm-slim | 128m | none |
| `install` | node:22-bookworm-slim | 512m | registry-only |
| `build` | node:22-bookworm-slim | 512m | none |
| `test` | node:22-bookworm-slim, playwright:v1.63.0-noble | 512m | none |
| `publish` | node:22-bookworm-slim | 256m | none |
| `delete` | alpine:3.20 | 64m | none |

## Environment

| Var | Default | Purpose |
|---|---|---|
| `RUNNER_WORK_ROOT` | `/var/lib/gameforge/work` | Workdirs must live inside this root |
| `RUNNER_LOG_ROOT` | `/var/lib/gameforge/runner-logs` | Per-run logs (0600) |
| `GF_DOCKER_BIN` | `docker` | Docker CLI path (override for tests) |

## Honest notes

- `oomKilled` is a heuristic (exit 137 without a timeout). Documented as such.
- `registry-only` networking uses the `gf-egress` Docker network, which must exist
  with an egress proxy that allowlists only the npm registry (and Playwright CDN
  for the test image). If the network is missing, `docker run` fails closed.
  The proxy itself is wired in Phase 7.
- The HTTP service binding for remote orchestration comes in Phase 3 — this
  package is the library.
- Real verification (actually spawning containers) happens on the Oracle host in
  Phase 7. This dev VM has no Docker; unit tests mock the spawn layer.
