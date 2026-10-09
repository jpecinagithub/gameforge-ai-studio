# DATABASE DESIGN — GameForge AI Studio

**Date:** 2026-10-09 · **Phase:** 1 (design) · **Implementation:** Phase 2
**Engine:** PostgreSQL 16+ · **Migrations:** versioned SQL files under
`infra/db/migrations/NNNN_name.sql`, applied by the API at startup (advisory-locked,
single migrator). No ORM magic — SQL is auditable.

## 0. Design principles

1. **Postgres is the durable source of truth for metadata; git is the source of truth
   for file content/history.** One git repo per project under
   `storage/projects/<project_id>/repo`. Never store large binaries in relational rows —
   content-addressed blob store `storage/blobs/<sha256[0:2]>/<sha256>` with DB metadata.
2. **Append-only where it matters:** `agent_events`, `audit_events` — inserts only,
   redaction applied *before* write (Genex's redaction-on-append, adapted).
3. **Soft delete for user data:** `deleted_at` on projects/assets; hard delete only via
   explicit purge job after the grace window. Removal hides, never destroys (Genex F6).
4. **Deterministic IDs:** run/job IDs generated as `run_<ulid>`-style deterministic
   strings at creation; idempotency keys unique per side-effecting operation.
5. **All timestamps `timestamptz`.** Money as `numeric`. Token counts as `bigint`.
6. **Secrets never in Postgres plaintext.** `application_settings` stores only
   non-secret config; secret *references* (vault paths) where needed, values live in
   the server vault.

## 1. Schema

### 1.1 projects
| column | type | notes |
|---|---|---|
| id | uuid PK | default gen_random_uuid() |
| slug | text unique not null | url-safe, immutable after create |
| name | text not null | user-editable |
| description | text | |
| template | text not null | one of the 8 starter templates |
| kind | text | first-person / third-person / top-down / side-2d / racing / flight / static-board / free-camera (Genex `loop/kinds.ts` adapted) |
| engine | text not null default 'three' | three \| phaser \| pixi \| canvas2d |
| status | text not null default 'active' | active \| archived |
| current_revision_id | uuid nullable → project_revisions | FK, set after commit |
| last_good_build_id | uuid nullable → build_jobs | FK, last verified/partial build |
| archived_at | timestamptz nullable | |
| deleted_at | timestamptz nullable | soft delete |
| metadata | jsonb not null default '{}' | cover path, engine version, game type |
| created_at / updated_at | timestamptz | |

Indexes: `projects(slug)`, `projects(status, updated_at DESC)`, `projects(deleted_at)`.

### 1.2 project_files (metadata; content lives in git + blob store)
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| project_id | uuid FK → projects, on delete cascade | |
| path | text not null | posix-relative, validated (no `..`, no absolute, no symlink escape) |
| content_hash | char(64) not null | sha256 of current content |
| size_bytes | bigint not null | |
| is_binary | boolean not null default false | |
| updated_at | timestamptz | mirrors git commit time |

Unique: `(project_id, path)`. Index: `project_files(project_id)`.

### 1.3 project_revisions
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| project_id | uuid FK cascade | |
| git_sha | char(40) not null | commit SHA in the project's repo |
| message | text not null | |
| author_kind | text not null | user \| agent:<role> \| system |
| run_id | text nullable → agent_runs.id | |
| checkpoint_kind | text nullable | agent_edit \| chat_message \| asset_delivery \| manual \| land |
| healthy | boolean not null default false | true only after a full harness turn past it (Genex F8) |
| created_at | timestamptz | |

Unique: `(project_id, git_sha)`. Index: `project_revisions(project_id, created_at DESC)`.

### 1.4 conversations / 1.5 messages
`conversations`: id uuid PK, project_id FK cascade, title text, created_at, updated_at.
`messages`: id uuid PK, conversation_id FK cascade, role text
(`user|assistant|system|tool`), content text not null, model text nullable,
usage jsonb (tokens), checkpoint_before_ref / checkpoint_after_ref text nullable
(git refs, Genex chat-checkpoint model), created_at.
Index: `messages(conversation_id, created_at)`.

### 1.6 agent_runs
| column | type | notes |
|---|---|---|
| id | text PK | deterministic, e.g. `run_01K…` (ULID) |
| project_id | uuid FK cascade | |
| conversation_id | uuid nullable FK | |
| mode | text not null | manual \| auto \| loop |
| status | text not null | queued\|planning\|running\|waiting_for_user\|building\|testing\|reviewing\|completed\|failed\|canceled\|interrupted |
| plan | jsonb | structured plan: facets, dependencies, acceptance criteria |
| current_step | text nullable | |
| idempotency_key | text unique not null | |
| budgets | jsonb not null | `{max_iterations, max_wallclock_ms, max_tokens, max_cost_usd}` |
| journal | jsonb not null default '{}' | run journal: worked clock, ledger, health, workers, wake state (Genex F3) |
| error | jsonb nullable | typed error code + detail |
| started_at / ended_at | timestamptz nullable | |
| created_at | timestamptz | |

Indexes: `agent_runs(project_id, created_at DESC)`, `agent_runs(status)`.

### 1.7 agent_tasks
id uuid PK, run_id FK → agent_runs cascade, agent_role text
(director\|gameplay\|scene_visual\|ui\|asset\|qa\|reviewer), status text
(queued\|running\|waiting\|completed\|failed\|canceled), model text,
prompt_version text, input jsonb, output jsonb, token_input/output bigint,
started_at/ended_at nullable, created_at.
Index: `agent_tasks(run_id, created_at)`.

### 1.8 agent_events (append-only)
id bigserial PK, run_id FK → agent_runs cascade, task_id uuid nullable,
seq bigint not null (per-run sequence), kind text not null
(decision\|tool_call\|tool_result\|build\|test\|model_call\|error\|retry\|pause\|resume\|complete\|question\|answer),
payload jsonb not null (**redacted before insert**), created_at.
Unique: `(run_id, seq)`. Index: `agent_events(run_id, seq)`.
Frontend replays via SSE with `Last-Event-ID = <run_id>:<seq>`.

### 1.9 build_jobs
| column | type | notes |
|---|---|---|
| id | text PK | `build_01K…` |
| project_id | uuid FK cascade | |
| run_id | text nullable FK | |
| revision_sha | char(40) not null | source commit built |
| status | text not null | queued\|building\|testing\|verifying\|verified\|partial\|failed\|canceled |
| build_dir | text not null | ephemeral shadow dir (never the project repo) |
| verdict | jsonb nullable | `{summary, failed_phase, acceptance: [{criterion, result}]}` |
| resource_usage | jsonb nullable | cpu_ms, peak_rss_mb, wall_ms |
| started_at / ended_at | timestamptz nullable | |
| created_at | timestamptz | |

Index: `build_jobs(project_id, created_at DESC)`.

### 1.10 build_artifacts
id uuid PK, build_id FK cascade, kind text
(bundle\|screenshot\|log\|report\|coverage\|videoframes), path text not null
(relative to artifact root), size_bytes bigint, content_hash char(64),
metadata jsonb (e.g. camera name, viewport, pixel stats).
Index: `build_artifacts(build_id, kind)`.

### 1.11 test_results
id uuid PK, build_id FK cascade, suite text, name text not null,
status text (pass\|fail\|skip\|error), duration_ms integer,
details jsonb, created_at.
Index: `test_results(build_id, suite)`.

### 1.12 review_results
id uuid PK, build_id FK cascade, run_id text nullable, criterion text not null,
result text (pass\|fail\|unverified), confidence numeric(3,2) nullable,
evidence jsonb (screenshot artifact refs, probe outputs),
issue text nullable, recommendation text nullable, retest_required boolean
default false, judge_model text, prompt_sha char(64) (provenance, Genex F4),
created_at.

### 1.13 assets
| column | type | notes |
|---|---|---|
| id | uuid PK | |
| project_id | uuid FK cascade | |
| path | text not null | posix-relative under `assets/` |
| kind | text not null | model\|material\|texture\|image\|sprite\|animation\|audio\|music\|video\|font\|other |
| format | text not null | glb, png, mp3… (from the format table) |
| bytes | bigint not null | |
| content_hash | char(64) not null | blob store key; dedup across projects |
| source | text not null | procedural\|blender\|imported\|upload\|plugin:<id> |
| job_id | text nullable | generation/Blender job |
| generation_id | uuid nullable → asset_generations | |
| prompt | text nullable | generation prompt, if any |
| license | text nullable | source + license metadata |
| use_stage | text not null default 'unconfirmed' | unconfirmed\|integrated\|verified (Genex F9) |
| properties | jsonb not null default '{}' | width/height/duration_ms/polycount… |
| deleted_at | timestamptz nullable | |
| created_at | timestamptz | |

Unique: `(project_id, path)`. Index: `assets(project_id, kind)`, `assets(content_hash)`.

### 1.14 asset_generations
id uuid PK, project_id FK cascade, provider text (blender\|procedural\|<api>),
kind text, status text (queued\|processing\|completed\|failed\|canceled),
prompt text, params jsonb, cost_credits numeric nullable,
result_asset_id uuid nullable → assets, error jsonb nullable, created_at.

### 1.15 plugins / 1.16 plugin_settings
`plugins`: id text PK (manifest id), version text, publisher text, name text,
description text, capabilities jsonb, install_state text
(enabled\|disabled\|not-enabled), origin text (local\|github:<sha>\|catalog),
manifest_sha char(64), installed_at, updated_at.
`plugin_settings`: plugin_id FK cascade, key text, value jsonb (secret values
→ vault reference, never plaintext), PK (plugin_id, key).

### 1.17 model_registry
id uuid PK, provider text not null default 'groq', model_id text unique not null,
display_name text, capabilities jsonb not null
(`{context_window, supports_tools, supports_vision, supports_json_mode, max_output_tokens}`),
discovered_at timestamptz, last_seen_at timestamptz, active boolean default true.
**Never hardcode model names in code** — all selection goes through this table,
refreshed from `GET /v1/models` at startup and on demand (master prompt §2).

### 1.18 model_usage
id bigserial PK, run_id text nullable, task_id uuid nullable, agent_role text,
model_id text not null, input_tokens bigint, output_tokens bigint,
cost_usd numeric nullable, latency_ms integer, created_at.
Index: `model_usage(created_at)`, `model_usage(run_id)`.
Feeds the diagnostics dashboard (AI usage/latency) and budget enforcement.

### 1.19 memories
id uuid PK, scope text (project\|studio\|run), project_id uuid nullable,
run_id text nullable, key text not null, content text not null,
salience numeric(3,2) default 0.5, version integer not null default 1,
superseded_by uuid nullable, created_at, updated_at.
Unique: `(scope, coalesce(project_id,'00000000-0000-0000-0000-000000000000'), key, version)` —
practically: partial unique index on `(scope, project_id, key)` where superseded_by is null
(current version). History preserved via superseded_by chain.

### 1.20 skill_versions
id uuid PK, skill_name text not null, version integer not null,
content text not null, status text (candidate\|active\|rejected\|rolled_back),
evidence jsonb (held-out gate results), created_at.
Unique: `(skill_name, version)`.

### 1.21 audit_events (append-only)
id bigserial PK, actor text not null (user\|system\|agent:<role>\|plugin:<id>),
action text not null, target text nullable, details jsonb (redacted),
created_at. Index: `audit_events(created_at)`, `audit_events(actor, action)`.

### 1.22 Append-only enforcement (migration 0004, Phase 7)

Both append-only tables carry a `BEFORE UPDATE OR DELETE` trigger
(`prevent_mutation_of_append_only()`) that raises instead of allowing the
write. The application only ever INSERTs into these tables, so the trigger is
transparent in normal operation. Retention/purge must use a separate
privileged procedure that drops the trigger first — the documented escape
hatch. The migration is applied by the standard idempotent runner; it was
written without a live Postgres in the build VM and is verified at first
Oracle boot (migration failures abort boot loudly).

### 1.22 application_settings
key text PK, value jsonb not null, updated_at.
**Rule:** secret *values* forbidden — store only non-secret config; secret references
(vault paths) allowed.

### 1.24 improvement_proposals + improvement_proposal_versions (migration 0003, Phase 6)
`improvement_proposals`: id uuid PK, version int, title, scope
(`prompt`|`config`|`code`), target (prompt name | settings key | repo-relative path),
change jsonb (scope-bounded payload), evidence jsonb (`[{kind:'build'|'review', id}]`
— must reference real rows, validated at write time), status
(`proposed`|`approved`|`applied`|`rejected`|`rolled_back`), proposed_by/approved_by
(actor identities — agents can never approve), approved_at/applied_at,
previous_state jsonb (rollback snapshot), outcome jsonb, timestamps.
`improvement_proposal_versions`: append-only history (proposal_id, version, change,
evidence, created_by, created_at). Apply semantics per scope: prompt → CANDIDATE row
in `skill_versions` (never activates); config → writes `application_settings`
(secret-like refused); code → unified diff stored for manual review, never executed.

## 2. Migration strategy

- `infra/db/migrations/0001_init.sql` … one file per change, never edited after merge.
- `down` migrations not maintained (forward-only; restore from backup).
- API startup: advisory lock `pg_advisory_lock(727312)` → run pending → release.
- Seed migration: inserts the 8 template definitions, default settings, and the
  agent-role registry (prompts versioned separately in `skill_versions`-adjacent config).

## 3. Retention & cleanup

- `agent_events`: keep all (they're the audit trail); archive partitions >1 year to
  cold storage.
- Build artifacts: keep `lastGood` + last 20 builds per project; older bundles pruned
  nightly (metadata rows kept).
- Screenshots: keep per judged build; raw evidence frames pruned after 30 days.
- `model_usage`: aggregate rollups after 90 days (keep per-run totals).
- Blob store: reference-counted by `assets.content_hash` + `build_artifacts.content_hash`;
  nightly GC of unreferenced blobs.

## 4. Backup & restore

Implemented in Phase 7 (`infra/backup/backup.sh`, `infra/backup/restore.sh`,
full procedure in `docs/BACKUPS.md`):

- **Database:** `pg_dump --format=custom` into a timestamped backup set,
  retained `GF_BACKUP_RETENTION_DAYS` (default 14); SHA-256 manifest per set.
- **Files:** `STORAGE_ROOT` (git repos, blobs, artifacts) as `storage.tar.gz`
  in the same set (excludes `backups/`, `work/`, `runner-logs/`).
- **Redis:** RDB copied out of the volume when present; the RDB is *not*
  restored into the live Redis (queue state rebuilds from Postgres).
- **Restore** is checksum-verified *before* touching live data, takes a
  reversible pre-restore snapshot first, and restores Postgres by
  drop+recreate (exact replacement, never a merge).
- The vault / `.env` secrets are **not** part of these backups — the operator
  backs them up separately and never commits them.

## 5. What this schema deliberately does NOT contain

- No users/accounts table (single-user, no login — by design).
- No API keys table (vault owns secrets).
- No revision content table (git owns it).
- No chat embeddings table in v1 (keyed retrieval first; embeddings optional later).
