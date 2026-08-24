#!/usr/bin/env bash
# Bring up an isolated QA stack on an auto-picked free port trio, so several
# can run side by side. Run from anywhere — the script cd's to the repo root.
#
# Usage:
#   scripts/qa-up.sh [ID]
#
# ID names the stack (docker project `fortymm-qa-<ID>`, default: current git
# branch, sanitized). Re-running with the same ID reuses that stack's
# containers/volumes. Each distinct ID gets its own nginx + Mailpit host ports,
# discovered by probing upward from the QA defaults (8085 / 8087) for a free
# pair, so concurrent stacks never collide.
#
# Override the search or pin exact ports:
#   QA_PORT=8090 QA_MAILPIT_PORT=8091 scripts/qa-up.sh pr604
#
# Bring one down:   scripts/qa-down.sh [ID]      (same ID derivation as here)
# Bring ALL down:   scripts/qa-down.sh --all     (add --prune-cache to reclaim
#                   the buildx cache too — a raw `compose down` leaves the
#                   built images and the build cache on disk, and they are what
#                   fill Docker.raw)
# List running:     docker compose ls | grep fortymm-qa

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Stack ID: arg 1, else the sanitized current branch.
raw_id="${1:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo qa)}"
QA_ID="$(printf '%s' "$raw_id" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//; s/-*$//')"
QA_ID="${QA_ID:-qa}"

# True if nothing is listening on the given TCP port (host side).
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

# Find the next free port at or above $1, skipping any already chosen.
next_free_port() {
  local start="$1" p="$1"; shift
  local taken=" $* "
  while [ "$p" -lt 65535 ]; do
    if [[ "$taken" != *" $p "* ]] && port_free "$p"; then
      printf '%s' "$p"; return 0
    fi
    p=$((p + 1))
  done
  echo "ERROR: no free port found at or above $start" >&2; exit 1
}

QA_PORT="${QA_PORT:-$(next_free_port 8085)}"
QA_MAILPIT_PORT="${QA_MAILPIT_PORT:-$(next_free_port 8087 "$QA_PORT")}"
export QA_ID QA_PORT QA_MAILPIT_PORT

PROJECT="fortymm-qa-${QA_ID}"
COMPOSE=(docker compose -p "$PROJECT" -f docker-compose.qa.yml)
QA_URL="http://127.0.0.1:${QA_PORT}"

echo "==> Stack    : $PROJECT"
echo "==> App      : $QA_URL"
echo "==> Mailpit  : http://127.0.0.1:${QA_MAILPIT_PORT}"
echo

echo "==> Building images and (re)starting containers"
"${COMPOSE[@]}" up -d --build

echo
echo "==> Waiting for api to finish migrations and report healthy"
deadline=$(( $(date +%s) + 120 ))
until curl -fsS --max-time 3 "$QA_URL/api/v1/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: $QA_URL/api/v1/health did not respond within 120s" >&2
    echo "--- recent api logs ---" >&2
    "${COMPOSE[@]}" logs --tail=40 api >&2 || true
    exit 1
  fi
  sleep 2
done

echo
echo "==> Container status"
"${COMPOSE[@]}" ps

echo
echo "QA stack up: $QA_URL  (Mailpit http://127.0.0.1:${QA_MAILPIT_PORT})"
echo "Tear down  : scripts/qa-down.sh $QA_ID   (also drops its volumes + built images)"
echo

echo "Seeded identities (sign in via Mailpit, http://127.0.0.1:${QA_MAILPIT_PORT}):"
echo "  qa-admin@example.com     Administrator"
echo "  qa-director@example.com  Beta tester"
echo "  qa-player@example.com    (default User only — the no-permission case)"
echo

# Machine-readable handoff — MUST be the last stdout line. Scripts/skills can
# `eval "$(scripts/qa-up.sh <id> | tee /dev/stderr | tail -n1)"` to import
# QA_URL / QA_MAILPIT_URL / QA_PROJECT while still streaming progress.
printf 'QA_URL=%s QA_MAILPIT_URL=http://127.0.0.1:%s QA_PROJECT=%s\n' \
  "$QA_URL" "$QA_MAILPIT_PORT" "$PROJECT"
