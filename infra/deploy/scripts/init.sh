#!/bin/bash
# GameForge AI Studio — storage init (referenced by infra/deploy/docker-compose.yml).
# Creates STORAGE_ROOT with 0700 so only the owner can read project repos,
# uploads, artifacts and backups. Idempotent: safe to re-run.
set -euo pipefail

ROOT="${STORAGE_ROOT:-/var/lib/gameforge}"

sudo mkdir -p "$ROOT"
sudo chown "$USER:$USER" "$ROOT"
sudo chmod 0700 "$ROOT"
for sub in projects blobs artifacts backups work runner-logs; do
  mkdir -p "$ROOT/$sub"
done
chmod 0700 "$ROOT"
ls -ld "$ROOT"
echo "storage ready at $ROOT"
