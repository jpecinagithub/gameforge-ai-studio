-- ============================================================================
-- GameForge AI Studio — 0001_init
-- Full schema per docs/DATABASE.md §1.1–1.22. PostgreSQL 16+.
-- Forward-only: never edit after merge. See infra/db/README.md.
-- Enum CHECK values match packages/shared/src/enums.ts exactly.
-- ============================================================================

-- Migration bookkeeping (used by the API's advisory-locked migrator).
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- 1.1 projects
CREATE TABLE projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  description        text,
  template           text NOT NULL,
  kind               text,
  engine             text NOT NULL DEFAULT 'three'
                     CHECK (engine IN ('three', 'phaser', 'pixi', 'canvas2d')),
  status             text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'archived')),
  current_revision_id uuid,               -- FK added below (circular)
  last_good_build_id  text,               -- FK added below (circular)
  archived_at        timestamptz,
  deleted_at         timestamptz,          -- soft delete
  metadata           jsonb NOT NULL DEFAULT '{}',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX projects_status_updated ON projects (status, updated_at DESC);
CREATE INDEX projects_deleted_at ON projects (deleted_at) WHERE deleted_at IS NOT NULL;

-- ----------------------------------------------------------- 1.2 project_files
CREATE TABLE project_files (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id   uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path         text NOT NULL,             -- posix-relative, validated in API
  content_hash char(64) NOT NULL,         -- sha256
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  is_binary    boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX project_files_project ON project_files (project_id);

-- ------------------------------------------------------- 1.3 project_revisions
CREATE TABLE project_revisions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  git_sha         char(40) NOT NULL,
  message         text NOT NULL,
  author_kind     text NOT NULL,          -- user | agent:<role> | system
  run_id          text,                       -- FK added via ALTER below (agent_runs created after)
  checkpoint_kind text CHECK (checkpoint_kind IS NULL OR checkpoint_kind IN
                    ('agent_edit', 'chat_message', 'asset_delivery', 'manual', 'land')),
  healthy         boolean NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, git_sha)
);
CREATE INDEX project_revisions_project_created
  ON project_revisions (project_id, created_at DESC);

-- project_revisions.run_id FK is added via ALTER TABLE after agent_runs exists
-- (see below), because agent_runs is defined after this table.

-- --------------------------------------------------------------- 1.6 agent_runs
-- (created early because project_revisions.run_id points at it)
CREATE TABLE agent_runs (
  id              text PRIMARY KEY,       -- run_<ulid>, deterministic
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  conversation_id uuid,                   -- FK added after conversations exists
  mode            text NOT NULL CHECK (mode IN ('manual', 'auto', 'loop')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','planning','running','waiting_for_user','building',
                     'testing','reviewing','completed','failed','canceled','interrupted')),
  plan            jsonb,
  current_step    text,
  idempotency_key text NOT NULL UNIQUE,
  budgets         jsonb NOT NULL DEFAULT '{}',
  journal         jsonb NOT NULL DEFAULT '{}',  -- run journal (Genex F3)
  error           jsonb,                   -- typed error code + detail
  started_at      timestamptz,
  ended_at        timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_runs_project_created ON agent_runs (project_id, created_at DESC);
CREATE INDEX agent_runs_status ON agent_runs (status);

-- Now the deferred FK from project_revisions.
ALTER TABLE project_revisions
  ADD CONSTRAINT project_revisions_run_fk
  FOREIGN KEY (run_id) REFERENCES agent_runs (id) ON DELETE SET NULL;

-- ------------------------------------------------------- 1.4 conversations
CREATE TABLE conversations (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  title      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX conversations_project ON conversations (project_id);

ALTER TABLE agent_runs
  ADD CONSTRAINT agent_runs_conversation_fk
  FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL;

-- --------------------------------------------------------------- 1.5 messages
CREATE TABLE messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id       uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  role                  text NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content               text NOT NULL,
  model                 text,
  usage                 jsonb,           -- token counts
  checkpoint_before_ref text,            -- git ref (Genex chat-checkpoint model)
  checkpoint_after_ref  text,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_created ON messages (conversation_id, created_at);

-- -------------------------------------------------------------- 1.7 agent_tasks
CREATE TABLE agent_tasks (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id        text NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  agent_role    text NOT NULL,           -- director|gameplay|scene_visual|ui|asset|qa|reviewer
  status        text NOT NULL DEFAULT 'queued' CHECK (status IN
                  ('queued','running','waiting','completed','failed','canceled')),
  model         text,
  prompt_version text,
  input         jsonb,
  output        jsonb,
  token_input   bigint CHECK (token_input IS NULL OR token_input >= 0),
  token_output  bigint CHECK (token_output IS NULL OR token_output >= 0),
  started_at    timestamptz,
  ended_at      timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_tasks_run_created ON agent_tasks (run_id, created_at);

-- ------------------------------------------------------------- 1.8 agent_events
CREATE TABLE agent_events (
  id         bigserial PRIMARY KEY,
  run_id     text NOT NULL REFERENCES agent_runs (id) ON DELETE CASCADE,
  task_id    uuid REFERENCES agent_tasks (id) ON DELETE SET NULL,
  seq        bigint NOT NULL,             -- per-run sequence; SSE replay key
  kind       text NOT NULL,               -- AgentEventKind (typed in app)
  payload    jsonb NOT NULL,              -- REDACTED BEFORE INSERT (app-level)
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, seq)
);
-- (run_id, seq) unique index doubles as the replay index.

-- -------------------------------------------------------------- 1.9 build_jobs
CREATE TABLE build_jobs (
  id             text PRIMARY KEY,        -- build_<ulid>, deterministic
  project_id     uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  run_id         text REFERENCES agent_runs (id) ON DELETE SET NULL,
  revision_sha   char(40) NOT NULL,
  status         text NOT NULL DEFAULT 'queued' CHECK (status IN
                   ('queued','building','testing','verifying','verified','partial','failed','canceled')),
  build_dir      text NOT NULL,           -- ephemeral shadow dir
  verdict        jsonb,
  resource_usage jsonb,
  started_at     timestamptz,
  ended_at       timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX build_jobs_project_created ON build_jobs (project_id, created_at DESC);

-- Circular FK from projects.last_good_build_id — added now that build_jobs exists.
ALTER TABLE projects
  ADD CONSTRAINT projects_last_good_build_fk
  FOREIGN KEY (last_good_build_id) REFERENCES build_jobs (id) ON DELETE SET NULL;

-- --------------------------------------------------------- 1.10 build_artifacts
CREATE TABLE build_artifacts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id     text NOT NULL REFERENCES build_jobs (id) ON DELETE CASCADE,
  kind         text NOT NULL,             -- bundle|screenshot|log|report|coverage|videoframes
  path         text NOT NULL,             -- relative to artifact root
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  content_hash char(64),
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX build_artifacts_build_kind ON build_artifacts (build_id, kind);

-- ------------------------------------------------------------ 1.11 test_results
CREATE TABLE test_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id    text NOT NULL REFERENCES build_jobs (id) ON DELETE CASCADE,
  suite       text,
  name        text NOT NULL,
  status      text NOT NULL CHECK (status IN ('pass','fail','skip','error')),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  details     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX test_results_build_suite ON test_results (build_id, suite);

-- ---------------------------------------------------------- 1.12 review_results
CREATE TABLE review_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  build_id         text NOT NULL REFERENCES build_jobs (id) ON DELETE CASCADE,
  run_id           text REFERENCES agent_runs (id) ON DELETE SET NULL,
  criterion        text NOT NULL,
  result           text NOT NULL CHECK (result IN ('pass','fail','unverified')),
  confidence       numeric(3,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  evidence         jsonb,
  issue            text,
  recommendation   text,
  retest_required  boolean NOT NULL DEFAULT false,
  judge_model      text,
  prompt_sha       char(64),              -- provenance (Genex F4)
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_results_build ON review_results (build_id);

-- ------------------------------------------------------ 1.14 asset_generations
CREATE TABLE asset_generations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  provider        text NOT NULL,          -- blender|procedural|<api>
  kind            text NOT NULL,          -- model|image|texture|audio|music|video|material
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN
                    ('queued','processing','completed','failed','canceled')),
  prompt          text,
  params          jsonb,
  cost_credits    numeric,
  result_asset_id uuid,                   -- FK added after assets exists (circular)
  error           jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX asset_generations_project ON asset_generations (project_id);

-- ---------------------------------------------------------------- 1.13 assets
CREATE TABLE assets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id    uuid NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  path          text NOT NULL,            -- posix-relative under assets/
  kind          text NOT NULL,            -- model|material|texture|image|sprite|animation|audio|music|video|font|other
  format        text NOT NULL,            -- glb|png|mp3… (format table)
  bytes         bigint NOT NULL CHECK (bytes >= 0),
  content_hash  char(64) NOT NULL,        -- blob store key; dedups across projects
  source        text NOT NULL,            -- procedural|blender|imported|upload|plugin:<id>
  job_id        text,
  generation_id uuid REFERENCES asset_generations (id) ON DELETE SET NULL,
  prompt        text,
  license       text,                     -- source + license metadata
  use_stage     text NOT NULL DEFAULT 'unconfirmed' CHECK (use_stage IN
                  ('unconfirmed','integrated','verified')),
  properties    jsonb NOT NULL DEFAULT '{}',
  deleted_at    timestamptz,              -- soft delete
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX assets_project_kind ON assets (project_id, kind);
CREATE INDEX assets_content_hash ON assets (content_hash);

-- Circular FK: asset_generations.result_asset_id -> assets.
ALTER TABLE asset_generations
  ADD CONSTRAINT asset_generations_result_asset_fk
  FOREIGN KEY (result_asset_id) REFERENCES assets (id) ON DELETE SET NULL;

-- Circular FK: projects.current_revision_id -> project_revisions.
ALTER TABLE projects
  ADD CONSTRAINT projects_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES project_revisions (id) ON DELETE SET NULL;

-- ---------------------------------------------------------------- 1.15 plugins
CREATE TABLE plugins (
  id            text PRIMARY KEY,         -- manifest id
  version       text NOT NULL,
  publisher     text,
  name          text NOT NULL,
  description   text,
  capabilities  jsonb NOT NULL DEFAULT '[]',
  install_state text NOT NULL DEFAULT 'not-enabled' CHECK (install_state IN
                   ('enabled','disabled','not-enabled')),
  origin        text,                     -- local|github:<sha>|catalog
  manifest_sha  char(64),
  installed_at  timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- 1.16 plugin_settings
CREATE TABLE plugin_settings (
  plugin_id text NOT NULL REFERENCES plugins (id) ON DELETE CASCADE,
  key       text NOT NULL,
  value     jsonb NOT NULL,               -- secret VALUES forbidden; vault refs only
  PRIMARY KEY (plugin_id, key)
);

-- ---------------------------------------------------------- 1.17 model_registry
CREATE TABLE model_registry (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider       text NOT NULL DEFAULT 'groq',
  model_id       text NOT NULL UNIQUE,    -- never hardcoded in app code
  display_name   text,
  capabilities   jsonb NOT NULL,          -- {context_window, supports_tools, supports_vision, supports_json_mode, max_output_tokens}
  discovered_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  active         boolean NOT NULL DEFAULT true
);

-- ------------------------------------------------------------- 1.18 model_usage
CREATE TABLE model_usage (
  id           bigserial PRIMARY KEY,
  run_id       text,                      -- references agent_runs(id); no FK: usage outlives runs
  task_id      uuid,
  agent_role   text,
  model_id     text NOT NULL,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cost_usd     numeric,
  latency_ms   integer CHECK (latency_ms IS NULL OR latency_ms >= 0),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_usage_created ON model_usage (created_at);
CREATE INDEX model_usage_run ON model_usage (run_id);

-- ---------------------------------------------------------------- 1.19 memories
CREATE TABLE memories (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         text NOT NULL CHECK (scope IN ('project','studio','run')),
  project_id    uuid REFERENCES projects (id) ON DELETE SET NULL,
  run_id        text REFERENCES agent_runs (id) ON DELETE SET NULL,
  key           text NOT NULL,
  content       text NOT NULL,
  salience      numeric(3,2) NOT NULL DEFAULT 0.5
                CHECK (salience >= 0 AND salience <= 1),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  superseded_by uuid REFERENCES memories (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
-- Current version per (scope, project, key): only one row with superseded_by IS NULL.
CREATE UNIQUE INDEX memories_current_key ON memories
  (scope, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
  WHERE superseded_by IS NULL;
CREATE INDEX memories_project ON memories (project_id);
CREATE INDEX memories_run ON memories (run_id);

-- ---------------------------------------------------------- 1.20 skill_versions
CREATE TABLE skill_versions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_name text NOT NULL,
  version    integer NOT NULL CHECK (version >= 1),
  content    text NOT NULL,
  status     text NOT NULL CHECK (status IN ('candidate','active','rejected','rolled_back')),
  evidence   jsonb,                      -- held-out gate results
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (skill_name, version)
);

-- ------------------------------------------------------------ 1.21 audit_events
CREATE TABLE audit_events (
  id         bigserial PRIMARY KEY,
  actor      text NOT NULL,               -- user|system|agent:<role>|plugin:<id>
  action     text NOT NULL,
  target     text,
  details    jsonb,                       -- REDACTED BEFORE INSERT (app-level)
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_created ON audit_events (created_at);
CREATE INDEX audit_events_actor_action ON audit_events (actor, action);

-- ----------------------------------------------------- 1.22 application_settings
CREATE TABLE application_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,              -- secret VALUES forbidden; vault refs only
  updated_at timestamptz NOT NULL DEFAULT now()
);
