#!/usr/bin/env bash
# =====================================================================
# GameForge AI Studio — backup script.
#
# Captures: Postgres custom-format dump, Redis RDB snapshot, and the
# STORAGE_ROOT tree (project git repos, asset blobs, artifacts).
# Writes a checksum manifest (SHA-256) next to the backup set.
#
# Idempotent: safe to re-run; each run creates a new timestamped set and
# prunes sets older than the retention window.
#
# Usage: infra/backup/backup.sh
# Required env (from infra/deploy/.env): POSTGRES_USER, POSTGRES_PASSWORD,
#   POSTGRES_DB, STORAGE_ROOT. Optional: GF_BACKUP_DIR (default
#   $STORAGE_ROOT/backups), GF_BACKUP_RETENTION_DAYS (default 14).
# =====================================================================
set -euo pipefail

: "${POSTGRES_USER:?POSTGRES_USER is not set — source infra/deploy/.env first}"
: "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is not set — source infra/deploy/.env first}"
: "${POSTGRES_DB:?POSTGRES_DB is not set — source infra/deploy/.env first}"
: "${STORAGE_ROOT:?STORAGE_ROOT is not set — source infra/deploy/.env first}"

BACKUP_DIR="${GF_BACKUP_DIR:-$STORAGE_ROOT/backups}"
RETENTION_DAYS="${GF_BACKUP_RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
SET_DIR="$BACKUP_DIR/$TS"

mkdir -p "$SET_DIR"
echo "[backup] set: $SET_DIR"

# --- 1. Postgres -------------------------------------------------------
export PGPASSWORD="$POSTGRES_PASSWORD"
echo "[backup] dumping postgres ($POSTGRES_DB) ..."
pg_dump -h "${POSTGRES_HOST:-127.0.0.1}" -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -Fc -f "$SET_DIR/postgres.dump"
unset PGPASSWORD

# --- 2. Redis RDB ------------------------------------------------------
# The redis service persists with --appendonly yes; the RDB file is the
# point-in-time snapshot. Copy it out of the named volume via a throwaway
# container so the running redis is never disturbed.
echo "[backup] snapshotting redis RDB ..."
REDIS_RDB_SRC="${GF_REDIS_RDB_SRC:-gameforge_redisdata}"
if docker volume inspect "$REDIS_RDB_SRC" >/dev/null 2>&1; then
  docker run --rm -v "$REDIS_RDB_SRC":/data:ro -v "$SET_DIR":/out:rw \
    alpine:3.20 sh -c 'cp /data/dump.rdb /out/redis-dump.rdb'
else
  echo "[backup] WARN: redis volume '$REDIS_RDB_SRC' not found — skipping RDB (queues rebuild from postgres on restore)"
fi

# --- 3. Storage tree ---------------------------------------------------
# Git repos + blobs + artifacts. Excludes the backups dir itself to avoid
# recursive bloat, and the runner workdirs (ephemeral).
echo "[backup] archiving storage tree ..."
tar -czf "$SET_DIR/storage.tar.gz" \
  --exclude='./backups' --exclude='./work' --exclude='./runner-logs' \
  -C "$STORAGE_ROOT" .

# --- 4. Manifest -------------------------------------------------------
echo "[backup] writing checksum manifest ..."
(
  cd "$SET_DIR"
  sha256sum postgres.dump redis-dump.rdb storage.tar.gz > MANIFEST.sha256 2>/dev/null || \
  sha256sum postgres.dump storage.tar.gz > MANIFEST.sha256
)

# --- 5. Retention -------------------------------------------------------
echo "[backup] pruning sets older than $RETENTION_DAYS days ..."
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENTION_DAYS" -print -exec rm -rf {} +

echo "[backup] DONE: $SET_DIR"
ls -la "$SET_DIR"
