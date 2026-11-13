#!/bin/sh
# preview-name.sh [--deletable] <service>
#
# The one rule for what a preview may be called. For a preview service's name
# it prints the preview's database and image package, derived from the name
# (never passed in): fortymm-api-pr-<number> gives "pr_<number> pr-<number>".
# Any other name is refused, before anything reaches Google Cloud.
#
# - Without --deletable (api:preview): a pull request's preview,
#   fortymm-api-pr-<number>, or fortymm-api-trial (database "trial") for trying
#   a branch by hand.
# - With --deletable (api:preview-delete): only fortymm-api-pr-<number>. The
#   trial, the shared instance's own name, its "postgres" database and any
#   production name are refused.
#
# The number is a pull request's: digits, no leading zero (so pr-9 and pr-09
# can't name one database twice), at most 9 of them. POSIX sh: it runs on the
# host, before the container starts, and again in the container.
# api:deploy-check proves the refusals.
set -eu

deletable=""
if [ "${1:-}" = "--deletable" ]; then
  deletable=1
  shift
fi

# shellcheck source=hosting.env
. "$(dirname "$0")/hosting.env"

# Everything it was given, for the refusal: two names are refused as one.
service="$*"
id=""
if [ "$#" -eq 1 ]; then
  case "$service" in
    "${SERVICE_PREFIX}pr-"*)
      number="${service#"${SERVICE_PREFIX}pr-"}"
      case "$number" in
        '' | 0* | *[!0-9]* | ??????????*) ;;
        *) id="pr-$number" ;;
      esac
      ;;
    "${SERVICE_PREFIX}trial")
      [ -n "$deletable" ] || id=trial
      ;;
  esac
fi

if [ -z "$id" ]; then
  if [ -n "$deletable" ]; then
    echo "api:preview-delete: refusing '$service': not a pull request's preview (${SERVICE_PREFIX}pr-<number>)." >&2
  else
    echo "api:preview: refusing '$service': a preview is ${SERVICE_PREFIX}pr-<number>, or ${SERVICE_PREFIX}trial to try a branch by hand." >&2
  fi
  exit 2
fi

# The database name: the id with "-" as "_" (a database name is an SQL
# identifier). The image package: the id.
echo "$(echo "$id" | tr - _) $id"
