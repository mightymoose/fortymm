#!/usr/bin/env bash
# Start the API (if it isn't already running) and block until /openapi.json
# responds. Shared by the regen-api-types / regen-ios-api-types mise tasks and
# the openapi-schema CI jobs so the boot-and-poll logic lives in one place.
#
# Usage: eval "$(scripts/ensure-api-up.sh | tail -n1)"  -- imports $API_URL
# and, only if this invocation started the server, $API_STARTED_PID (kill it
# on your own exit so a one-off regen doesn't leave the server running). The
# `tail -n1` matters: only the final line is the machine-readable handoff,
# not a contract callers should rely on for every line printed.
#
# If `uvicorn` is already resolvable (CI installs API deps globally with no
# venv), that's used directly; otherwise falls back to a local api/.venv,
# creating it on first use.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
API_PORT="${API_PORT:-8000}"
API_URL="http://${API_HOST}:${API_PORT}"

probe() { curl -fs -o /dev/null --max-time 1 "$API_URL/openapi.json"; }

API_PID=""
if probe; then
  echo "Using API already running at $API_URL" >&2
else
  echo "Starting API server at $API_URL..." >&2
  if command -v uvicorn >/dev/null 2>&1; then
    UVICORN=uvicorn
  else
    if [ ! -x "$ROOT/api/.venv/bin/uvicorn" ]; then
      python -m venv "$ROOT/api/.venv"
      "$ROOT/api/.venv/bin/pip" install -q -e "$ROOT/api[dev]"
    fi
    UVICORN="$ROOT/api/.venv/bin/uvicorn"
  fi
  "$UVICORN" app.main:app --host "$API_HOST" --port "$API_PORT" \
    --app-dir "$ROOT/api" >/tmp/fortymm-api.log 2>&1 &
  API_PID=$!

  for _ in $(seq 1 60); do
    if probe; then break; fi
    sleep 0.5
  done
  if ! probe; then
    echo "API failed to start. Last log:" >&2
    tail -n 40 /tmp/fortymm-api.log >&2 || true
    kill "$API_PID" 2>/dev/null || true
    exit 1
  fi
fi

# Machine-readable handoff — MUST be the last stdout line (see qa-up.sh).
printf 'API_URL=%s API_STARTED_PID=%s\n' "$API_URL" "$API_PID"
