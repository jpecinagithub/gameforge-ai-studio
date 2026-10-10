#!/bin/bash
# GameForge — script único
# Uso:
#   bash gf.sh update   → git pull + rebuild worker
#   bash gf.sh status   → estado del último run + actividad reciente
#   bash gf.sh question → muestra la pregunta pendiente (si hay)
set -e
cd "$(dirname "$0")"
cd ~/gameforge-ai-studio/infra/deploy 2>/dev/null || cd "$(dirname "$0")"

case "$1" in
  update)
    echo "=== Actualizando código ==="
    cd ~/gameforge-ai-studio && git pull 2>&1 | tail -1
    cd infra/deploy
    echo "=== Reconstruyendo worker ==="
    docker compose up --build -d worker 2>&1 | tail -1
    echo "=== Worker listo ==="
    ;;
  status)
    echo "=== Último run ==="
    docker compose exec -T postgres psql -U gameforge -d gameforge -c \
      "SELECT id, status, current_step FROM agent_runs ORDER BY created_at DESC LIMIT 1;" 2>&1 | head -5
    echo ""
    echo "=== Actividad reciente (últimos 5 eventos) ==="
    docker compose exec -T postgres psql -U gameforge -d gameforge -c \
      "SELECT kind, left(payload::text, 65) FROM agent_events WHERE run_id = (SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT 1) ORDER BY seq DESC LIMIT 5;" 2>&1 | head -10
    echo ""
    echo "=== Modelo en uso ==="
    docker compose logs worker --tail=20 2>&1 | grep "cf-debug.*model:" | tail -1
    ;;
  question)
    echo "=== Pregunta pendiente ==="
    docker compose exec -T postgres psql -U gameforge -d gameforge -c \
      "SELECT payload::text FROM agent_events WHERE kind = 'question_asked' AND run_id = (SELECT id FROM agent_runs ORDER BY created_at DESC LIMIT 1) ORDER BY seq DESC LIMIT 1;" 2>&1 | head -5
    ;;
  *)
    echo "Uso: bash gf.sh [update|status|question]"
    ;;
esac
