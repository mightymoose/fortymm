#!/bin/sh
# deploy.sh [worker] [option...]
#
# Deploys the build (web-client/dist) with this directory's wrangler.jsonc: to
# the Worker named `worker`, or, when it is empty or left out, to the
# production Worker named in wrangler.jsonc. Further options go to
# `wrangler deploy`. web-client:deploy runs it for real; web-client:deploy-check
# runs it with --dry-run, for both kinds of name.
set -eu

worker="${1:-}"
[ "$#" -eq 0 ] || shift
if [ -n "$worker" ]; then
  set -- --name "$worker" "$@"
fi

exec npx wrangler deploy "$@"
