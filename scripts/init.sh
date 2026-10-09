#!/usr/bin/env bash
# GameForge AI Studio — first-boot initialization (Oracle Cloud Linux).
# Plain-language: checks prerequisites, creates storage, pre-pulls images.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../infra/deploy" && pwd)"
cd "$DEPLOY_DIR"

echo "==> 1/5 Checking prerequisites (docker + compose plugin)..."
command -v docker >/dev/null 2>&1 || { echo "ERROR: 'docker' not found. Install Docker Engine first."; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "ERROR: 'docker compose' plugin not found."; exit 1; }
echo "    docker: $(docker --version)"

echo "==> 2/5 Checking .env..."
if [ ! -f .env ]; then
  cp .env.example .env
  echo "    Created .env from .env.example."
  echo "    ACTION NEEDED: edit .env (GF_DOMAIN, POSTGRES_PASSWORD, GROQ_API_KEY, ALLOWED_ORIGINS)"
  echo "    then re-run this script."
  exit 1
fi
# shellcheck disable=SC1091
set -a; source .env; set +a
: "${STORAGE_ROOT:=/var/lib/gameforge}"
echo "    STORAGE_ROOT=$STORAGE_ROOT"

echo "==> 3/5 Creating storage directories (0700)..."
for d in projects blobs artifacts backups work runner-logs; do
  mkdir -p "$STORAGE_ROOT/$d"
done
chmod 0700 "$STORAGE_ROOT"
echo "    created: projects blobs artifacts backups work runner-logs"

echo "==> 4/5 Pre-pulling pinned images (runner uses --pull never)..."
# Keep in sync with apps/runner/src/images.ts + docker-compose.yml.
for img in \
  node:22-bookworm-slim \
  mcr.microsoft.com/playwright:v1.63.0-noble \
  alpine:3.20 \
  postgres:16-bookworm \
  redis:7-bookworm \
  caddy:2-alpine ; do
  echo "    pulling $img..."
  docker pull "$img"
done

echo "==> 5/5 Creating the gf-egress network (registry-only jobs)..."
if docker network inspect gf-egress >/dev/null 2>&1; then
  echo "    gf-egress already exists."
else
  docker network create --internal gf-egress
  echo "    created internal network 'gf-egress'."
  echo "    NOTE: the egress PROXY (allowlist: npm registry + Playwright CDN) is"
  echo "    wired in Phase 7. Until then, registry-only jobs fail closed."
fi

echo ""
echo "Init complete. Next:"
echo "  docker compose up -d --build"
echo "  docker compose exec runner node apps/runner/dist/service.js --check"
