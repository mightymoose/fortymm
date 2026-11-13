#!/bin/sh
# api-origin.sh [worker]
#
# Prints the api a Worker forwards /api/* to, given at deploy as its
# API_ORIGIN variable (src/index.ts), or nothing for a Worker given none:
#
# - the production Worker (no name, or the name in wrangler.jsonc): none.
#   There is no production api; /api/* stays a 404.
# - fortymm-pr-<number>, a pull request's preview: that pull request's api
#   preview, fortymm-api-pr-<number>.
# - fortymm-trial, a branch tried by hand: the api's trial, fortymm-api-trial.
#
# Any other name is refused. The api preview's address is made from its name
# by the api's own script (api/hosting/preview-address.sh, from
# api/hosting/hosting.env), which also refuses a number no api preview can
# have. web-client:deploy runs this on the host; web-client:deploy-check
# proves each case.
set -eu

worker="$*"
here=$(dirname "$0")
production=$(sed -n 's/^  "name": "\(.*\)",$/\1/p' "$here/../wrangler.jsonc")
if [ -z "$production" ]; then
  echo "web-client:deploy: found no Worker name in web-client/worker/wrangler.jsonc." >&2
  exit 1
fi

case "$worker" in
  '' | "$production") exit 0 ;;
  "$production-pr-"* | "$production-trial") ;;
  *)
    echo "web-client:deploy: refusing '$worker': a Worker is the production one ('$production'), $production-pr-<number> (a pull request's preview) or $production-trial, so it is known which api it forwards to." >&2
    exit 2
    ;;
esac

# shellcheck source=../../../api/hosting/hosting.env
. "$here/../../../api/hosting/hosting.env"
sh "$here/../../../api/hosting/preview-address.sh" "$SERVICE_PREFIX${worker#"$production-"}"
