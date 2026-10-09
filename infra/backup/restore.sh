#!/usr/bin/env bash
# =====================================================================
# GameForge AI Studio — restore script.
#
# Restores ONE backup set created by infra/backup/backup.sh. The restore is
# REVERSIBLE: a pre-restore snapshot of the live data is taken first, so a
# bad restore can itself be rolled back with this same script.
#
# Usage: infra/backup/restore.sh <backup-set-dir> [--postgres-only|--storage-only]
#   Example: infra/backup/restore.sh /var/lib/gameforge/backups/20261009T180000Z
#
# Required env (from infra/deploy/.env): POSTGRES_USER, POSTGRES_PASSWORD,
#   POSTGRES_DB, STORAGE_ROOT.
#
# DANGER: this replaces live data. It refuses to run unless every checksum
# in MANIFEST.sha256 verifies.
# =====================================================================
set -euo pipefail

SET_DIR="${1:?usage: restore.sh <backup-set-dir> [--postgres-only|--storage-only]}"
MODE="${2:-full}"

: "${POSTGRES_USER:?POSTGRES_USER is not set — source infra/deploy/.env first}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set — source infra/deploy/.env first}"
: "${POSTGRES_DB:?POSTGRES_DB is not set — source infra/deploy/.env first}"
: "${STORAGE_ROOT:?STORAGE_ROOT is not set — source infra/deploy/.env first}"

if [ ! -d "$SET_DIR" ]; then
  echo "[restore] ERROR: backup set not found: $SET_DIR" >&2
  exit 1
fi

echo "[restore] verifying checksums ..."
(cd "$SET_DIR" && sha256sum -c MANIFEST.sha256)
echo "[restore] checksums OK"

# --- 0. Pre-restore snapshot (reversibility) -----------------------------
SNAP_TS="$(date -u +%Y%m%dT%H%M%SZ)"
SNAP_DIR="$STORAGE_ROOT/backups/pre-restore-$SNAP_TS"
mkdir -p "$SNAP_DIR"
echo "[restore] pre-restore snapshot: $SNAP_DIR"
export PGPASSWORD="$POSTGRES_PASSWORD"
pg_dump -h "${POSTGRES_HOST:-127.0.0.1}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -f "$SNAP_DIR/postgres.dump"
unset PGPASSWORD
tar -czf "$SNAP_DIR/storage.tar.gz" \
  --exclude='./backups' --exclude='./work' --exclude='./runner-logs' \
  -C "$STORAGE_ROOT" .
(cd "$SNAP_DIR" && sha256sum postgres.dump storage.tar.gz > MANIFEST.sha256)
echo "[restore] snapshot complete — to undo this restore, run:"
echo "[restore]   $0 $SNAP_DIR ${MODE}"

# --- 1. Postgres ---------------------------------------------------------
if [ "$MODE" = "full" ] || [ "$MODE" = "--postgres-only" ]; then
  echo "[restore] restoring postgres from $SET_DIR/postgres.dump ..."
  echo "[restore] stopping api/worker to drain writers ..."
  (cd "$(dirname "$0")/../deploy" && docker compose stop api worker) || true
  export PGPASSWORD="$POSTGRES_PASSWORD"
  # Drop + recreate so the restore is exact, not a merge.
  psql -h "${POSTGRES_HOST:-127.0.0.1}" -U "$POSTGRES_USER" -d postgres \
    -c "DROP DATABASE \"$POSTGRES_DB\";" -c "CREATE DATABASE \"$POSTGRES_DB\";"
  pg_restore -h "${POSTGRES_HOST:-127.0.0.1}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    "$SET_DIR/postgres.dump"
  unset PGPASSWORD
  echo "[restore] postgres restored"
fi

# --- 2. Storage tree -----------------------------------------------------
if [ "$MODE" = "full" ] || [ "$MODE" = "--storage-only" ]; then
  echo "[restore] restoring storage tree from $SET_DIR/storage.tar.gz ..."
  tar -xzf "$SET_DIR/storage.tar.gz" -C "$STORAGE_ROOT"
  echo "[restore] storage restored"
fi

# --- 3. Redis ------------------------------------------------------------
# BullMQ jobs are durable queue state, but they reference DB rows; on a
# postgres restore the queue is rebuilt by re-queueing. We do NOT restore the
# RDB into the live redis — stale jobs would reference dropped rows.
echo "[restore] note: redis is intentionally NOT restored (queue state rebuilds from postgres)"

echo "[restore] restart the stack: (cd infra/deploy && docker compose up -d)"
echo "[restore] DONE"
