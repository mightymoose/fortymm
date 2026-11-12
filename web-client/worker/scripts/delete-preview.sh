#!/bin/sh
# delete-preview.sh [--check-name] <worker>
#
# Deletes a pull request's preview Worker from Cloudflare. Only ever a name of
# the form fortymm-pr-<number> (CI's preview job deploys to those): any other
# name, the production Worker's and fortymm-trial included, is refused before
# anything reaches Cloudflare. A preview that doesn't exist (never deployed, or
# already deleted) is not an error. With --check-name, it only checks the name.
#
# web-client:preview-delete runs it; CI's cleanup workflow runs that when a
# pull request closes. web-client:deploy-check proves the refusals.
set -eu

check_only=""
if [ "${1:-}" = "--check-name" ]; then
  check_only=1
  shift
fi

worker="${1:-}"
number="${worker#fortymm-pr-}"
if [ "$#" -ne 1 ] || [ "$number" = "$worker" ]; then
  number=""
fi
case "$number" in
  '' | *[!0-9]*)
    echo "web-client:preview-delete: refusing '$worker': not a pull request's preview Worker (fortymm-pr-<number>)." >&2
    exit 2
    ;;
esac
[ -z "$check_only" ] || exit 0

sh "$(dirname "$0")/with-credentials.sh"

log=$(mktemp)
trap 'rm -f "$log"' EXIT
if npx wrangler delete "$worker" >"$log" 2>&1; then
  cat "$log"
  echo "web-client:preview-delete: deleted $worker."
  exit 0
fi
# Cloudflare's error for a Worker that doesn't exist.
if grep -qF '[code: 10007]' "$log"; then
  echo "web-client:preview-delete: $worker doesn't exist; nothing to delete."
  exit 0
fi
cat "$log" >&2
exit 1
