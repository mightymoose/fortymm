#!/bin/sh
# deploy.sh <worker> <api origin> [option...]
#
# Deploys the build (web-client/dist) with this directory's wrangler.jsonc: to
# the Worker named `worker`, or, when it is empty, to the production Worker
# named in wrangler.jsonc. `api origin` is the api the Worker forwards /api/*
# to (its API_ORIGIN variable, src/index.ts), as api-origin.sh prints it for
# that Worker; empty, the Worker keeps wrangler.jsonc's empty API_ORIGIN and
# answers /api/* with a 404. The production Worker is never given one.
# Further options go to `wrangler deploy`. web-client:deploy runs it for real;
# web-client:deploy-check runs it with --dry-run, for each kind of name.
set -eu

if [ "$#" -lt 2 ]; then
  echo "usage: deploy.sh <worker> <api origin> [option...] (either may be empty)" >&2
  exit 2
fi
worker="$1"
api_origin="$2"
shift 2

if [ -z "$worker" ] && [ -n "$api_origin" ]; then
  echo "web-client:deploy: refusing to give the production Worker an api ('$api_origin'): there is no production api." >&2
  exit 2
fi
if [ -n "$api_origin" ]; then
  set -- --var "API_ORIGIN:$api_origin" "$@"
fi
if [ -n "$worker" ]; then
  set -- --name "$worker" "$@"
fi

exec npx wrangler deploy "$@"
