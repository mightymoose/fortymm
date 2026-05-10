#!/usr/bin/env bash
# Boots an RQ worker and the FastAPI server together so Playwright can wait on
# /openapi.json. Either child exiting brings the script down, and SIGTERM from
# Playwright cleanly terminates both. Shares REDIS_URL with both processes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
API_DIR="$(cd "$SCRIPT_DIR/../../api" && pwd)"

cd "$API_DIR"

if [ -x ".venv/bin/uvicorn" ]; then
  UVICORN=".venv/bin/uvicorn"
  RQ=".venv/bin/rq"
else
  UVICORN="$(command -v uvicorn)"
  RQ="$(command -v rq)"
fi

REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6379/0}"
export REDIS_URL

"$RQ" worker solver --url "$REDIS_URL" &
WORKER_PID=$!

"$UVICORN" app.main:app --host 127.0.0.1 --port "${API_PORT:-8000}" &
UVICORN_PID=$!

cleanup() {
  trap - EXIT INT TERM
  kill -TERM "$WORKER_PID" "$UVICORN_PID" 2>/dev/null || true
  wait "$WORKER_PID" 2>/dev/null || true
  wait "$UVICORN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

wait -n "$WORKER_PID" "$UVICORN_PID"
