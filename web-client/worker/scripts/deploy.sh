#!/bin/sh
# deploy.sh <worker> <api-origin> [option...]
#
# Deploys the build (web-client/dist) with this directory's wrangler.jsonc: to
# the Worker named `worker`, or, when it is empty, to the production Worker
# named in wrangler.jsonc. With an api origin (https://host, no path), the
# Worker forwards /api/* there (API_ORIGIN); when it is empty, it has no api
# and answers /api/* with a 404. Anything else is refused before Wrangler
# runs. Further options go to `wrangler deploy`. web-client:deploy runs it for
# real; web-client:deploy-check runs it with --dry-run.
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: deploy.sh <worker> <api-origin> [option...] (either may be empty)" >&2
  exit 2
fi
worker="$1"
api="$2"
shift 2

if [ -n "$api" ]; then
  host="${api#https://}"
  case "$host" in
    "$api" | '' | *[!A-Za-z0-9.:-]* | .* | :*)
      echo "web-client:deploy: refusing api origin '$api': not https://<host>, with no path." >&2
      exit 2
      ;;
  esac
  # Wrangler lists a --var's value as "(hidden)", so say it here.
  echo "web-client:deploy: /api/* goes to $api (API_ORIGIN)."
  set -- --var "API_ORIGIN:$api" "$@"
else
  echo "web-client:deploy: no api origin; /api/* is a 404."
fi
if [ -n "$worker" ]; then
  set -- --name "$worker" "$@"
fi

exec npx wrangler deploy "$@"
