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
#
# `lsof` is a hard dependency, used to positively confirm which PID owns the
# port's LISTEN socket before reporting success (see owns_listen_socket()
# below) -- present by default on macOS and on GitHub's ubuntu-latest runners,
# and already relied on unguarded by scripts/qa-up.sh's port_free(). This is a
# deliberate fail-closed choice, not an oversight: unlike the optional-tool
# checks in .githooks/pre-push (mise, swift), which degrade to a warning
# because CI's own verify job re-checks the same thing, ownership has no
# downstream backstop -- degrading here would mean accepting an unverified
# "success" for the exact false-provenance hazard this script exists to
# close. A missing lsof is expected to be rare (see runners above); if it
# turns out not to be, fix it by getting lsof onto that machine, not by
# loosening this check.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
API_HOST="${API_HOST:-127.0.0.1}"
# Keyed by this invocation's own PID ($$), not a fixed name -- two concurrent
# callers must not truncate each other's log, or the failure-path `tail`
# below can show an unrelated run's output instead of the one that failed.
API_LOG="/tmp/fortymm-api.$$.log"
# Removed on any exit, success or failure -- the failure path already tails
# it to stderr before this fires, and a running server keeps writing to the
# unlinked inode until the caller kills it (fine; it's a throwaway server).
# Without this, every invocation (mise tasks, pre-push, CI) leaves a new
# PID-named file behind permanently -- an unbounded /tmp accumulation this
# repo has been burned by before at the Docker-image layer.
trap 'rm -f "$API_LOG"' EXIT

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
  # explicit API_PORT collision is handled below: the readiness loop's final
  # check requires owns_listen_socket() to name our own PID as the port's
  # owner, so a foreign process winning this race is never mistaken for
  # success, regardless of whether it also answers /openapi.json.
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
  # SO_REUSEADDR matters here: without it, a port left in TIME_WAIT by a
  # server that already exited (e.g. an immediately-preceding run on the same
  # explicit API_PORT) can make this bind fail even though nothing is
  # actually listening -- uvicorn itself sets this flag, so skipping it here
  # made this preflight stricter than the server it's standing in for. It
  # does NOT let a bind succeed over another process's live LISTEN socket on
  # the same port -- only TCP's own OS-level SO_REUSEADDR semantics apply,
  # unrelated to SO_REUSEPORT.
  if ! bind_err="$(API_HOST="$API_HOST" API_PORT="$API_PORT" "$PY" -c '
import os, socket, sys
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
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

# A successful probe() only proves *something* answers /openapi.json on
# $API_URL -- it cannot distinguish our own uvicorn from a foreign process
# that grabbed the port in the race window between our preflight/ephemeral
# bind releasing it and uvicorn's own bind (see the comment above the final
# check below). Liveness of $API_PID doesn't close that gap either: uvicorn
# can still be alive and simply not have reached its own bind_socket() call
# yet. The only way to know who actually holds the port is to ask the kernel
# which PID owns the LISTEN socket, and require that to be exactly ours.
# `lsof -t` prints bare PIDs, one per line, of processes with a socket
# matching the filter; scoping to `-sTCP:LISTEN` and this exact host:port,
# and then requiring the output to equal $API_PID (not merely contain it),
# is what makes this a positive ownership check rather than another liveness
# probe -- only one process can hold a LISTEN socket on a given host:port at
# a time (no SO_REUSEPORT is set anywhere in this script or by uvicorn's
# default bind), so if the kernel says $API_PID owns it, nothing else does.
owns_listen_socket() {
  local listeners
  if ! command -v lsof >/dev/null 2>&1; then
    echo "lsof not found -- cannot verify socket ownership, refusing to assume it." >&2
    echo "Install lsof (present by default on macOS; on Debian/Ubuntu: apt-get install lsof) and retry." >&2
    return 1
  fi
  listeners="$(lsof -nP -iTCP@"$API_HOST":"$API_PORT" -sTCP:LISTEN -t 2>/dev/null || true)"
  [ "$listeners" = "$API_PID" ]
}

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
# race window instead of a stale-listener reuse. Requiring our own PID to
# still be alive does NOT close that window: uvicorn can be alive and simply
# not have reached its own bind() yet, so "probe succeeds" + "our PID is
# alive" can both hold while a foreign process, not us, is what answered.
# owns_listen_socket() closes it for real, by asking the kernel who currently
# holds the port's LISTEN socket rather than inferring it from process
# liveness.
#
# Each condition is captured ONCE, here, rather than re-run inside the
# diagnostic branch below. Re-running them there would reopen a small TOCTOU
# in the diagnostic itself: a legitimately slow (not foreign-beaten) uvicorn
# could finish binding in the gap between this check and a second probe/kill
# -0, making the diagnostic wrongly claim "a foreign process answered" for a
# server that was actually ours, just slow. Reusing the captured values keeps
# the diagnostic's claim consistent with the reason the check actually failed.
probe_ok=1; probe || probe_ok=0
pid_alive=1; kill -0 "$API_PID" 2>/dev/null || pid_alive=0
owns_ok=1; owns_listen_socket || owns_ok=0

if [ "$probe_ok" -eq 0 ] || [ "$pid_alive" -eq 0 ] || [ "$owns_ok" -eq 0 ]; then
  if [ "$probe_ok" -eq 1 ] && [ "$pid_alive" -eq 1 ]; then
    # owns_ok is the only thing that failed. That's either a real foreign
    # process holding the port, or ownership simply couldn't be verified
    # (e.g. no lsof -- owns_listen_socket already printed that reason above).
    # Don't overclaim which one it was; either way we refuse to report success.
    echo "$API_URL answers and PID $API_PID is alive, but it could not be confirmed as the port's owner. Refusing to report success." >&2
  else
    echo "API failed to start. Last log:" >&2
    tail -n 40 "$API_LOG" >&2 || true
  fi
  kill "$API_PID" 2>/dev/null || true
  exit 1
fi

# Machine-readable handoff — MUST be the last stdout line (see qa-up.sh).
printf 'API_URL=%s API_STARTED_PID=%s\n' "$API_URL" "$API_PID"
