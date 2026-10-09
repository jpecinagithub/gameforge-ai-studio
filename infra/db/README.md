# Database migrations — GameForge AI Studio

PostgreSQL 16+. Versioned SQL files, applied by the API at startup.

## Policy (forward-only)

- Files are named `NNNN_name.sql` and applied in lexicographic order, exactly once,
  tracked in `schema_migrations(filename)`.
- The API is the single migrator: at startup it takes
  `pg_advisory_lock(727312)`, applies pending files inside one transaction each,
  records them in `schema_migrations`, then releases the lock.
- **Never edit a migration after it has been merged/applied.** Fix forward with a
  new `NNNN` file.
- **No down migrations are maintained.** To roll back schema: restore the database
  from backup (`scripts/restore.sh`, documented in `docs/ORACLE_INSTALL.md` Phase 7).

## Adding a migration

1. Pick the next sequence number (`0003_...`).
2. Write plain, auditable SQL (no ORM). Keep CHECK enum values in sync with
   `packages/shared/src/enums.ts` — the check script asserts the key values.
3. Run `node scripts/check-migrations.mjs` and keep it green.
4. Live migration testing happens on the Oracle server (Phase 7) — this dev VM has
   no Postgres. Be extra careful: every statement in a migration must be valid
   PostgreSQL 16.

## Seed data

`0002_seed.sql` inserts default `application_settings` with
`ON CONFLICT (key) DO NOTHING` (safe to re-run).
**Rule: secret VALUES are forbidden in seed/migrations.** Secret *references*
(vault paths) are allowed; values live in the server vault.
