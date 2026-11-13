#!/usr/bin/env bash
# exists.sh: sourced by preview.sh and delete-preview.sh.
#
# exists <task> <gcloud's not-found message> <gcloud describe args...>
#
# True when the describe succeeds, false when gcloud says the resource was not
# found (its message for that kind of resource, taken from real runs:
# "Cannot find service [<name>]" for Cloud Run, "HTTPError 404" for a Cloud SQL
# database, "NOT_FOUND:" for an image package). Any other failure, such as a
# 503 or a permission refused, is not "gone": it shows gcloud's message and
# stops the script, so nothing after it runs. tests/describe-answers.sh proves
# it, with a stand-in gcloud.
exists() {
  local task=$1 not_found=$2 err
  shift 2
  if err=$(gcloud "$@" 2>&1 >/dev/null); then
    return 0
  fi
  if grep -qF -- "$not_found" <<<"$err"; then
    return 1
  fi
  echo "$task: stopping: couldn't tell whether it exists (gcloud $1 $2 $3 $4 failed, not with \"not found\"):" >&2
  grep -v "^WARNING: This command is using service account impersonation" <<<"$err" >&2
  exit 1
}
