#!/usr/bin/env bash
# describe-answers.sh
#
# Claim: delete-preview.sh and preview.sh take a resource as gone only when
# gcloud says it was not found. Any other failure of a describe (a 503, a
# permission change...) stops the script, shows gcloud's message and changes
# nothing after it; it never reads as "nothing to delete", and preview.sh
# never goes on to create the database.
#
# Runs in the api-hosting container (api:deploy-check), with stand-ins for
# gcloud and docker (tests/stand-in/) first on PATH: the rule is how the
# scripts read gcloud's answers, so no Google Cloud is needed.
set -u
hosting=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$hosting/tests/stand-in:$PATH"
export STAND_IN_LOG
STAND_IN_LOG=$(mktemp)
failures=0

# run_case <description> <expected exit: 0 or fail> <expected changes> <shown> <script> <args...>
# with STAND_IN_SERVICE, STAND_IN_DATABASE and STAND_IN_PACKAGE set.
run_case() {
  local what=$1 want_exit=$2 want_changes=$3 want_shown=$4
  shift 4
  : >"$STAND_IN_LOG"
  out=$(bash "$hosting/${1:?}" "${@:2}" 2>&1)
  status=$?
  changes=$(sed 's/ --.*//' "$STAND_IN_LOG" | paste -sd';' -)
  problem=""
  if [ "$want_exit" = 0 ] && [ "$status" != 0 ]; then problem="exited $status"; fi
  if [ "$want_exit" = fail ] && [ "$status" = 0 ]; then problem="exited 0"; fi
  [ "$changes" = "$want_changes" ] || problem="$problem; changes: '$changes', expected '$want_changes'"
  case "$out" in *"$want_shown"*) ;; *) problem="$problem; didn't show '$want_shown'" ;; esac
  if [ -n "$problem" ]; then
    echo "FAILED  $what: ${problem#; }"
    while IFS= read -r line; do echo "          $line"; done <<<"$out"
    failures=$((failures + 1))
  else
    echo "ok      $what"
  fi
}

delete=(delete-preview.sh fortymm-api-pr-9)
STAND_IN_SERVICE=found STAND_IN_DATABASE=found STAND_IN_PACKAGE=found \
  run_case "delete: all three there are deleted, service first" 0 \
  "run services delete fortymm-api-pr-9;sql databases delete pr_9;artifacts packages delete pr-9" "deleted the image package" "${delete[@]}"
STAND_IN_SERVICE=absent STAND_IN_DATABASE=absent STAND_IN_PACKAGE=absent \
  run_case "delete: all three not found is nothing to delete" 0 "" "no image package pr-9; nothing to delete" "${delete[@]}"
STAND_IN_SERVICE=error STAND_IN_DATABASE=found STAND_IN_PACKAGE=found \
  run_case "delete: the service's describe failing stops it, changing nothing" fail "" "HTTPError 503" "${delete[@]}"
STAND_IN_SERVICE=absent STAND_IN_DATABASE=error STAND_IN_PACKAGE=found \
  run_case "delete: the database's describe failing stops it, changing nothing" fail "" "HTTPError 503" "${delete[@]}"
STAND_IN_SERVICE=found STAND_IN_DATABASE=found STAND_IN_PACKAGE=error \
  run_case "delete: the package's describe failing stops it, after what it could delete" fail \
  "run services delete fortymm-api-pr-9;sql databases delete pr_9" "HTTPError 503" "${delete[@]}"

preview=(preview.sh fortymm-api-pr-9 local-image tag)
STAND_IN_SERVICE=found STAND_IN_DATABASE=absent STAND_IN_PACKAGE=found \
  run_case "preview: a database not found is created, then the service deployed (the stand-in has no address, so it ends there)" fail \
  "sql databases create pr_9;run deploy fortymm-api-pr-9" "creating the database pr_9" "${preview[@]}"
STAND_IN_SERVICE=found STAND_IN_DATABASE=error STAND_IN_PACKAGE=found \
  run_case "preview: the database's describe failing stops it, creating nothing" fail "" "HTTPError 503" "${preview[@]}"

rm -f "$STAND_IN_LOG"
if [ "$failures" -gt 0 ]; then
  echo "describe-answers.sh: $failures case(s) failed."
  exit 1
fi
echo "describe-answers.sh: a describe reads as gone only on gcloud's not-found; any other failure stops the script and shows gcloud's message."
