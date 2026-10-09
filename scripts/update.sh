#!/usr/bin/env bash
# GameForge AI Studio — update a running deployment.
# Plain-language: pull code, rebuild images, restart. The API runs pending
# DB migrations at boot (forward-only), so no separate migrate step.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo "==> 1/4 Pulling latest code..."
git pull --ff-only
echo "    at: $(git rev-parse --short HEAD)"

echo "==> 2/4 Rebuilding images..."
cd infra/deploy
docker compose build

echo "==> 3/4 Restarting services (migrations run inside api at boot)..."
docker compose up -d

echo "==> 4/4 Waiting for health..."
for i in $(seq 1 24); do
  if docker compose exec -T api node -e \
    "fetch('http://127.0.0.1:8090/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    echo "    api is healthy."
    break
  fi
  if [ "$i" -eq 24 ]; then
    echo "ERROR: api did not become healthy. Check: docker compose logs api"
    exit 1
  fi
  sleep 5
done

echo ""
echo "Update complete. Verify:"
echo "  docker compose ps"
echo "  curl https://\${GF_DOMAIN}/api/v1/ready   # 200 only when pg+redis are up"
