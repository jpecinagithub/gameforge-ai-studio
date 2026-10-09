#!/usr/bin/env node
/**
 * check-migrations.mjs — static validation for infra/db/migrations/*.sql.
 *
 * This dev VM has no Postgres, so live migration testing is deferred to the
 * Oracle server (Phase 7). This script is the local gate: it asserts structure,
 * enum parity with packages/shared/src/enums.ts, idempotent seeds, and that no
 * secret-looking values leak into migrations.
 *
 * Exit 0 = green. Any failure prints to stderr and exits 1.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'infra', 'db', 'migrations');

const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); };

// Expected tables: schema_migrations + the 22 from docs/DATABASE.md §1.
const EXPECTED_TABLES = [
  'schema_migrations',
  'projects', 'project_files', 'project_revisions', 'conversations', 'messages',
  'agent_runs', 'agent_tasks', 'agent_events', 'build_jobs', 'build_artifacts',
  'test_results', 'review_results', 'assets', 'asset_generations', 'plugins',
  'plugin_settings', 'model_registry', 'model_usage', 'memories', 'skill_versions',
  'audit_events', 'application_settings',
];

// Enum literals that must appear in 0001_init.sql (parity with shared/enums.ts).
const REQUIRED_LITERALS = [
  // RunStatus
  "'queued'", "'planning'", "'running'", "'waiting_for_user'", "'building'",
  "'testing'", "'reviewing'", "'completed'", "'failed'", "'canceled'", "'interrupted'",
  // ExecutionMode
  "'manual'", "'auto'", "'loop'",
  // BuildStatus
  "'verifying'", "'verified'", "'partial'",
  // TaskStatus
  "'waiting'",
  // AssetUseStage
  "'unconfirmed'", "'integrated'",
  // PluginInstallState
  "'enabled'", "'disabled'", "'not-enabled'",
  // projects
  "'active'", "'archived'", "'three'", "'phaser'", "'pixi'", "'canvas2d'",
  // messages.role
  "'user'", "'assistant'", "'system'", "'tool'",
  // test_results.status
  "'pass'", "'fail'", "'skip'", "'error'",
  // review_results.result
  "'unverified'",
  // memories.scope
  "'project'", "'studio'", "'run'",
  // skill_versions.status
  "'candidate'", "'rejected'", "'rolled_back'",
  // checkpoint_kind
  "'agent_edit'", "'chat_message'", "'asset_delivery'", "'land'",
];

const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
ok(files.length > 0, 'no migration files found');
ok(
  files.every((f, i) => f === files.slice().sort()[i]),
  'migration files are not in lexicographic order',
);
for (const f of files) {
  ok(/^\d{4}_[a-z0-9_]+\.sql$/.test(f), `bad migration filename: ${f}`);
}

const sql0001 = files.includes('0001_init.sql')
  ? readFileSync(join(dir, '0001_init.sql'), 'utf8')
  : '';
const sql0002 = files.includes('0002_seed.sql')
  ? readFileSync(join(dir, '0002_seed.sql'), 'utf8')
  : '';

for (const t of EXPECTED_TABLES) {
  const re = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?${t}\\b`, 'i');
  ok(re.test(sql0001), `0001_init.sql: missing CREATE TABLE ${t}`);
}

for (const lit of REQUIRED_LITERALS) {
  ok(sql0001.includes(lit), `0001_init.sql: missing enum literal ${lit}`);
}

// Every file must end with a semicolon (complete final statement).
for (const f of files) {
  const body = readFileSync(join(dir, f), 'utf8').trim();
  ok(body.endsWith(';'), `${f}: does not end with a semicolon`);
}

// No destructive drops in migrations (forward-only policy).
for (const f of files) {
  const body = readFileSync(join(dir, f), 'utf8');
  ok(!/DROP\s+TABLE/i.test(body), `${f}: DROP TABLE is forbidden (forward-only)`);
  ok(!/DROP\s+DATABASE/i.test(body), `${f}: DROP DATABASE is forbidden`);
}

// Seed must be idempotent and secret-free.
ok(/ON\s+CONFLICT/i.test(sql0002), '0002_seed.sql: not idempotent (missing ON CONFLICT)');
const SECRET_PATTERNS = [/gsk_[A-Za-z0-9_-]{6,}/, /genex_sk_v1_/, /BEGIN [A-Z ]*PRIVATE KEY/, /password\s*['"]\s*:/i];
for (const f of files) {
  const body = readFileSync(join(dir, f), 'utf8');
  for (const p of SECRET_PATTERNS) {
    ok(!p.test(body), `${f}: looks like a secret value (${p})`);
  }
}

if (failures.length > 0) {
  for (const m of failures) console.error(`FAIL: ${m}`);
  console.error(`\ncheck-migrations: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log(`check-migrations: OK (${files.length} files, ${EXPECTED_TABLES.length} tables, ${REQUIRED_LITERALS.length} enum literals)`);
