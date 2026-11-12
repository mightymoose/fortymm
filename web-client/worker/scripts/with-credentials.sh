#!/bin/sh
# Fails, saying which are missing, unless both Cloudflare credentials are set
# in the environment; then runs the given command, if any. web-client:deploy
# runs it before building, and around `wrangler deploy`, so Wrangler never
# falls back to asking for a login. web-client:deploy-check runs it with
# neither set and expects that failure.
set -eu

missing=""
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || missing="$missing CLOUDFLARE_API_TOKEN"
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || missing="$missing CLOUDFLARE_ACCOUNT_ID"

if [ -n "$missing" ]; then
  echo "web-client:deploy: missing credentials:$missing." >&2
  echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in the environment" >&2
  echo "(in CI, the repository secrets of the same names). web-client/README.md," >&2
  echo "\"Hosting\", says how to make the token." >&2
  exit 1
fi

[ "$#" -eq 0 ] || exec "$@"
