# Backups & restore — GameForge AI Studio

**Scope:** Postgres + Redis RDB + the `STORAGE_ROOT` tree (project git repos,
content-addressed blobs, artifacts). Cloudflare tokens and the vault are **not** backed
up by these scripts — they live in `infra/deploy/.env` (0600), which the
operator backs up separately and never commits.

## What a backup set contains

```
$STORAGE_ROOT/backups/<UTC-timestamp>/
  postgres.dump      # pg_dump custom format (-Fc)
  redis-dump.rdb     # copied out of the redis volume (if present)
  storage.tar.gz     # STORAGE_ROOT minus backups/, work/, runner-logs/
  MANIFEST.sha256    # SHA-256 checksums of the three files above
```

Retention: sets older than `GF_BACKUP_RETENTION_DAYS` (default 14) are pruned.

## Taking a backup

```bash
cd ~/gameforge-ai-studio
set -a; source infra/deploy/.env; set +a
./infra/backup/backup.sh
```

The script is idempotent and safe to re-run. It refuses to run if
`POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` or `STORAGE_ROOT` is unset.

## Restoring

Restore is **explicit and reversible**: `restore.sh` first takes a
`pre-restore-<timestamp>` snapshot of the *live* data, so a bad restore can be
undone by restoring the snapshot with the same script.

```bash
set -a; source infra/deploy/.env; set +a
./infra/backup/restore.sh /var/lib/gameforge/backups/20261009T180000Z
# postgres only:  ./infra/backup/restore.sh <set> --postgres-only
# storage only:   ./infra/backup/restore.sh <set> --storage-only
cd infra/deploy && docker compose up -d
```

Checksums are verified **before** anything is touched — a set with a failed
checksum is never restored. Redis is intentionally *not* restored: BullMQ queue
state references DB rows, and stale jobs would dangle after a Postgres
restore. Queues rebuild from the restored Postgres on startup.

## Restore drill (run after every fresh install, then quarterly)

Expected outputs are shown after each step.

1. **Take a baseline backup** and note the set directory.
   ```
   ./infra/backup/backup.sh
   # → [backup] DONE: /var/lib/gameforge/backups/20261009T180000Z
   ```
2. **Create a canary project** via the studio UI (name it `drill-canary`), then
   stop the stack: `docker compose stop api worker`.
3. **Restore the baseline set.**
   ```
   ./infra/backup/restore.sh /var/lib/gameforge/backups/20261009T180000Z
   # → [restore] checksums OK
   # → [restore] pre-restore snapshot: .../pre-restore-20261009T181500Z
   # → [restore] postgres restored / storage restored
   ```
4. **Start the stack** (`docker compose up -d`) and confirm the canary project
   is **gone** from the dashboard (proving the restore actually replaced data,
   not merged it).
5. **Undo the drill** by restoring the pre-restore snapshot printed in step 3,
   then confirm the canary project is **back**.
6. Record the drill date + outcome in `docs/ACCEPTANCE_REPORT.md`.

A drill that skips step 4's negative check proves nothing — the check is the
whole point.

## Encryption & off-host copies

The scripts above cover *capture*. Per `docs/THREAT_MODEL.md` §T13 the operator
must additionally:

- encrypt backup sets at rest (`age`/`gpg` — operator's key, not in the repo),
- copy them off the Oracle host (object storage or a second machine),
- log who accessed them.

These steps are deliberately *not* scripted here: encryption keys and off-host
destinations are operator secrets, and a script that handles them would need
them in the repo.
