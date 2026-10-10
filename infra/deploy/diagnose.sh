#!/bin/bash
# GameForge AI Studio — single diagnostic script
# Run: bash diagnose.sh
# Collects: container health, model registry, recent runs, worker activity
set -e
cd "$(dirname "$0")"

echo "=== 1. Container health ==="
docker compose ps --format "table {{.Name}}\t{{.Status}}" | head -10

echo ""
echo "=== 2. API health ==="
curl -s -m 10 -o /dev/null -w "health: %{http_code}\n" https://iadelveloper-server.tail821379.ts.net:8443/api/v1/health || echo "health: FAILED"

echo ""
echo "=== 3. Model registry (DB) ==="
docker compose exec -T postgres psql -U gameforge -d gameforge -c \
  "SELECT model_id, active, (capabilities->>'supports_tools') as tools FROM model_registry WHERE active = true ORDER BY model_id LIMIT 40;" 2>&1 | head -45

echo ""
echo "=== 4. Recent runs (last 5) ==="
PID=$(curl -s -m 10 https://iadelveloper-server.tail821379.ts.net:8443/api/v1/projects | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['items'][0]['id'])" 2>/dev/null || echo "")
if [ -n "$PID" ]; then
  curl -s -m 10 "https://iadelveloper-server.tail821379.ts.net:8443/api/v1/projects/$PID/runs" | python3 -c "
import json,sys
d = json.load(sys.stdin)
for r in d['items'][:5]:
    print(r['id'][:20], r['status'], r.get('currentStep'))
" 2>/dev/null || echo "runs: query failed"
else
  echo "runs: no projects found"
fi

echo ""
echo "=== 5. Redis queue depth ==="
for q in agent-runs builds; do
  w=$(docker compose exec -T redis redis-cli llen "bull:$q:wait" 2>/dev/null || echo "?")
  a=$(docker compose exec -T redis redis-cli llen "bull:$q:active" 2>/dev/null || echo "?")
  echo "$q: wait=$w active=$a"
done

echo ""
echo "=== 6. Worker recent activity (last 8 lines) ==="
docker compose logs worker --tail=8 2>&1 | tail -8

echo ""
echo "=== Done ==="
