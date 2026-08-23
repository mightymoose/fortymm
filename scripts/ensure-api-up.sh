#!/usr/bin/env bash
# Start a fresh API server and block until /openapi.json responds. Shared by
# the regen-api-types / regen-ios-api-types mise tasks and the openapi-schema
# CI jobs so the boot-and-poll logic lives in one place.
#
# Every invocation starts its own server on its own port. It never reuses a
# listener already answering on a port, even one that looks like the API --
# `:8000` is shared with `docker-compose.dev.yml` and any hand-run `uvicorn`,
# and a foreign checkout's server there serves a spec this working tree did
# not produce. See .claude/rules/verify-the-artifact-under-test.md.
#
# Usage: eval "$(scripts/ensure-api-up.sh | tail -n1)"  -- imports $API_URL
# and $API_STARTED_PID (always set; kill it on your own exit so a one-off
# regen doesn't leave the server running). The `tail -n1` matters: only the
# final line is the machine-readable handoff, not a contract callers should
# rely on for every line printed.
#
# API_PORT, if set, is used as given -- a port already bound there is a hard
# failure (checked with our own bind attempt, not an HTTP probe, so a
# pre-existing listener can never read as success), never a signal to reuse
# whatever answers. Left unset, a fresh ephemeral port is chosen per
# invocation, so two callers running at once never collide.
#
# If `uvicorn` is already resolvable (CI installs API deps globally with no
# venv), that's used directly; otherwise falls back to a local api/.venv,
# creating it on first use.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
# Keyed by this invocation's own PID ($$), not a fixed name -- two concurrent
# callers must not truncate each other's log, or the failure-path `tail`
# below can show an unrelated run's output instead of the one that failed.
API_LOG="/tmp/fortymm-api.$$.log"

pick_python() {
  if command -v python3 >/dev/null 2>&1; then
    echo python3
  else
    echo python
  fi
}

PY="$(pick_python)"

if [ -z "${API_PORT:-}" ]; then
  # A short bind-to-port-0 probe: ask the OS for a free ephemeral port, read
  # it back, and release it immediately. `python`/`python3` is already a hard
  # dependency here (the .venv fallback below shells out to it). This is a
  # probe, not a reservation -- something else could in principle grab the
  # same port before uvicorn binds it. That race is handled the same way an
  # explicit API_PORT collision is handled below: the readiness loop notices
  # uvicorn died and fails loudly, it never falls back to whatever is now
  # listening.
  API_PORT="$(API_HOST="$API_HOST" "$PY" -c '
import os, socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind((os.environ["API_HOST"], 0))
print(s.getsockname()[1])
s.close()
')"
else
  # An explicit API_PORT is proven free before uvicorn ever tries it. An HTTP
  # probe can't do this job: if something is already answering on this exact
  # port -- a foreign checkout's server, the exact hazard this script exists
  # to close -- it responds to /openapi.json exactly like a freshly started
  # one would, so the readiness loop's `probe()` below would report success
  # for a server that never bound. Binding it ourselves, first, gives a fast,
  # specific diagnostic (the OS's own "Address already in use") instead of
  # waiting out the readiness loop; the loop's own final check (below) is what
  # actually closes this hazard for both port-selection paths, including the
  # narrow race after this bind releases the port and before uvicorn's own
  # bind -- this preflight is a UX improvement layered on that guarantee, not
  # a second independent one.
  if ! bind_err="$(API_HOST="$API_HOST" API_PORT="$API_PORT" "$PY" -c '
import os, socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
try:
    s.bind((os.environ["API_HOST"], int(os.environ["API_PORT"])))
except (OSError, ValueError) as e:
    print(e, file=sys.stderr)
    sys.exit(1)
finally:
    s.close()
' 2>&1)"; then
    # Could be a genuinely-bound port (the common case) or an invalid
    # API_PORT value (e.g. non-numeric) -- $bind_err carries the specific
    # reason either way, so the framing here stays deliberately generic
    # rather than asserting "already bound" for both.
    echo "Cannot bind API_PORT=$API_PORT on $API_HOST:" >&2
    echo "$bind_err" >&2
    exit 1
  fi
fi
API_URL="http://${API_HOST}:${API_PORT}"

probe() { curl -fs -o /dev/null --max-time 1 "$API_URL/openapi.json"; }

echo "Starting API server at $API_URL..." >&2
if command -v uvicorn >/dev/null 2>&1; then
  UVICORN=uvicorn
else
  if [ ! -x "$ROOT/api/.venv/bin/uvicorn" ]; then
    "$PY" -m venv "$ROOT/api/.venv"
    "$ROOT/api/.venv/bin/pip" install -q -e "$ROOT/api[dev]"
  fi
  UVICORN="$ROOT/api/.venv/bin/uvicorn"
fi
# Ask for the deterministic, network-free FakeGeocoder BY NAME. GEOCODER
# defaults to `google`, and a `google` with no GOOGLE_GEOCODING_API_KEY makes
# Settings raise at construction — which `lifespan` would hit at boot. This
# throwaway server exists only to serve /openapi.json for a type regen; it
# never geocodes anything, and a developer with no Google key must not have a
# routine `mise run regen-api-types` fail on a config guard.
GEOCODER="${GEOCODER:-fake}" \
"$UVICORN" app.main:app --host "$API_HOST" --port "$API_PORT" \
  --app-dir "$ROOT/api" >"$API_LOG" 2>&1 &
API_PID=$!

for _ in $(seq 1 60); do
  if probe; then break; fi
  # The process may already have died -- an explicit API_PORT already held, or
  # the rare free-port race above. Break out early instead of burning the full
  # 30s timeout; the combined check right below turns this into the same
  # loud, non-zero-exit failure either way, with uvicorn's own bind-error log
  # line as the reason.
  if ! kill -0 "$API_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
# A successful probe alone isn't proof OUR uvicorn is what answered: in the
# sliver between our preflight bind check releasing the port (or the
# ephemeral-port probe above) and uvicorn's own bind, a foreign process can
# grab the port and might itself answer /openapi.json coherently -- the same
# false-provenance hazard this script exists to close, just relocated to a
# race window instead of a stale-listener reuse. Require our own PID to still
# be alive, not just a response, before calling the start a success.
if ! probe || ! kill -0 "$API_PID" 2>/dev/null; then
  echo "API failed to start. Last log:" >&2
  tail -n 40 "$API_LOG" >&2 || true
  kill "$API_PID" 2>/dev/null || true
  exit 1
fi

# Machine-readable handoff — MUST be the last stdout line (see qa-up.sh).
printf 'API_URL=%s API_STARTED_PID=%s\n' "$API_URL" "$API_PID"
