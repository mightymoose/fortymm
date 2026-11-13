#!/bin/sh
# deploy-check.sh
#
# What can be proven about api's hosting without credentials (api:deploy-check,
# the last step of api:validate). Run from the repository's root by mise, with
# its Compose settings.
#
# 1. Without credentials, the setup, the check, the preview and the preview
#    delete each stop first, saying so, before reading or changing anything in
#    Google Cloud. gcloud gets an empty configuration, so a login kept in the
#    api-hosting-gcloud volume is not used.
# 2. Each preview gets its own database and image package, derived from its
#    name: fortymm-api-pr-9 gets pr_9, fortymm-api-pr-10 gets pr_10.
# 3. The preview delete refuses every name but fortymm-api-pr-<number>
#    (the trial, the shared instance's own name, its postgres database, a
#    production-looking name, two names...), in the task on the host before
#    the container starts, and again in the container. api:preview refuses
#    names outside its rule before it builds anything.
# 4. The preview and its delete take a resource as gone only when gcloud says
#    "not found"; any other failure stops them (tests/describe-answers.sh).
set -eu

hosting=api/hosting
fail() {
  echo "api:deploy-check: $*" >&2
  exit 1
}

docker compose --profile tools build api-hosting
compose_log=$(mktemp)
trap 'rm -f "$compose_log"' EXIT

# no_login <command...>: the command's own output, run in api-hosting with no
# credentials (Compose's output goes to $compose_log).
no_login() {
  docker compose --profile tools run --rm -T -e CLOUDSDK_CONFIG=/tmp/no-login api-hosting \
    sh -c '"$@" 2>&1' sh "$@" 2>"$compose_log"
}

# ---- 1. Without credentials, everything stops first --------------------------
# stops_first <what> <its first words> <command...>
stops_first() {
  what=$1 expected=$2
  shift 2
  if out=$(no_login "$@"); then
    fail "$what ran without credentials."
  fi
  case "$out" in
    "$expected"*) echo "Without credentials, $what stops first: $(echo "$out" | head -n 1)" ;;
    *) fail "$what failed without credentials, but not first and with: $out $(cat "$compose_log")" ;;
  esac
}
stops_first api:hosting-setup "api:hosting-setup: gcloud has no credentials, so nothing was read or changed." bash setup.sh
stops_first api:hosting-check "api:hosting-check: gcloud has no credentials, so nothing was read or changed." bash setup.sh --check
stops_first api:preview "api:preview: missing credentials:" bash preview.sh fortymm-api-pr-9 no-image no-tag
stops_first api:preview-delete "api:preview-delete: missing credentials:" bash delete-preview.sh fortymm-api-pr-9

# ---- 2. Each preview its own database and image package ----------------------
# maps <flag or ""> <service> <database package>
maps() {
  flag=$1 service=$2 expected=$3
  # shellcheck disable=SC2086
  got=$(sh "$hosting/preview-name.sh" $flag "$service") || fail "$service was refused${flag:+ ($flag)}."
  [ "$got" = "$expected" ] || fail "$service gives '$got', expected '$expected'."
}
maps "" fortymm-api-pr-9 "pr_9 pr-9"
maps "" fortymm-api-pr-10 "pr_10 pr-10"
maps "" fortymm-api-pr-90 "pr_90 pr-90"
maps "" fortymm-api-trial "trial trial"
maps --deletable fortymm-api-pr-9 "pr_9 pr-9"
echo "Each preview gets its own database and image package: fortymm-api-pr-9 pr_9, fortymm-api-pr-10 pr_10, fortymm-api-pr-90 pr_90, fortymm-api-trial trial."

# ---- 3. The refusals -----------------------------------------------------------
not_deletable="fortymm-api-preview
postgres
cloudsqladmin
template1
fortymm-api
fortymm-api-production
fortymm-api-trial
fortymm-pr-9
fortymm-api-pr-
fortymm-api-pr-9x
fortymm-api-pr-09
fortymm-api-pr-0
fortymm-api-pr--9
fortymm-api-pr-1234567890
x-fortymm-api-pr-9
fortymm-api-pr-9/..
fortymm-api-pr-9 fortymm-api"
# refused <flag> <name...>: preview-name.sh refuses it, with its message.
refused() {
  flag=$1
  shift
  if out=$(sh "$hosting/preview-name.sh" "$flag" "$@" 2>&1); then
    fail "preview-name.sh $flag accepted '$*'."
  fi
  case "$out" in
    *"refusing '$*'"*) ;;
    *) fail "preview-name.sh $flag stopped at '$*', but said: $out" ;;
  esac
}
echo "$not_deletable" | while IFS= read -r name; do refused --deletable "$name"; done
refused --deletable ""
refused --deletable fortymm-api-pr-9 fortymm-api-pr-10
echo "The preview delete's rule refuses every name but fortymm-api-pr-<number>, two names included."

# In the tasks, before anything else runs: no Compose output, no build.
# task_refuses <task> <name> <message>
task_refuses() {
  if out=$(./bin/mise run "$1" -- "$2" 2>&1); then
    fail "$1 accepted '$2'."
  fi
  case "$out" in
    *"$3"*) ;;
    *) fail "$1 stopped at '$2', but said: $out" ;;
  esac
  case "$out" in
    *Container* | *"docker build"* | *"Building"*) fail "$1 started something before refusing '$2': $out" ;;
  esac
}
for name in fortymm-api-preview postgres fortymm-api fortymm-api-trial; do
  task_refuses api:preview-delete "$name" "refusing '$name': not a pull request's preview"
done
for name in fortymm-api-preview postgres fortymm-api; do
  task_refuses api:preview "$name" "refusing '$name': a preview is"
done
echo "api:preview-delete refuses fortymm-api-preview, postgres, fortymm-api and fortymm-api-trial, and api:preview the first three, before anything runs."

# And in the container, should the script be run without the task.
for args in "fortymm-api-preview" "postgres" "fortymm-api-pr-9 fortymm-api"; do
  # shellcheck disable=SC2086
  if out=$(no_login bash delete-preview.sh $args); then
    fail "delete-preview.sh accepted '$args'."
  fi
  case "$out" in
    *"refusing '$args'"*) ;;
    *) fail "delete-preview.sh stopped at '$args', but said: $out" ;;
  esac
done
echo "delete-preview.sh refuses them too, two names included, before it asks for credentials; fortymm-api-pr-9 gets past the name and stops at the credentials (above)."

# ---- 4. "Gone" only when gcloud says not found ---------------------------------
# How the preview scripts read a describe's answer, with stand-ins for gcloud
# and docker (tests/describe-answers.sh): any failure but "not found" stops
# them, showing gcloud's message.
if ! out=$(no_login bash tests/describe-answers.sh); then
  fail "a describe's failure is read wrongly: $out"
fi
echo "$out" | tail -n 1
