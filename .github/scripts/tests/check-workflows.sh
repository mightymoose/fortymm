#!/usr/bin/env bash
# check-workflows.sh (tests)
#
# Claim: check-workflows.sh passes the workflows as they are, and fails each
# copy of them that breaks one of its rules: pull-requests: write given to
# another job or at the top level; the comment job given a secret, an
# id-token or a checkout of the pull request; the comment job running where
# the previews don't, or not after both; a job needing the comment job.
#
# Each case breaks one copy of .github/workflows with yq. The workflows task
# runs it.
set -u
github=$(cd "$(dirname "$0")/../.." && pwd)
check="$github/scripts/check-workflows.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
failures=0

# breaks <description> <file> <yq expression> <expected message>
breaks() {
  local what=$1 file=$2 expr=$3 want=$4
  rm -rf "$work/workflows"
  cp -R "$github/workflows" "$work/workflows"
  yq -i "$expr" "$work/workflows/$file"
  if out=$(bash "$check" "$work/workflows" 2>&1); then
    echo "FAILED  $what: the check passed"
    failures=$((failures + 1))
  elif [[ "$out" != *"$want"* ]]; then
    echo "FAILED  $what: the check failed, but didn't say '$want':"
    while IFS= read -r line; do echo "          $line"; done <<<"$out"
    failures=$((failures + 1))
  else
    echo "ok      $what"
  fi
}

if out=$(bash "$check" "$github/workflows" 2>&1); then
  echo "ok      the workflows as they are pass"
else
  echo "FAILED  the workflows as they are fail:"
  while IFS= read -r line; do echo "          $line"; done <<<"$out"
  failures=$((failures + 1))
fi

comment='.jobs["preview-comment"]'
breaks "the web client's preview (Cloudflare secrets) given pull-requests: write" ci.yml \
  '.jobs.preview.permissions = {"contents": "read", "pull-requests": "write"}' "ci.yml:preview ci.yml:preview-comment"
breaks "the api's preview (id-token) given pull-requests: write" ci.yml \
  '.jobs["preview-api"].permissions["pull-requests"] = "write"' "ci.yml:preview-api"
breaks "the cleanup workflow's job given write-all" preview-cleanup.yml \
  '.jobs["delete-preview"].permissions = "write-all"' "preview-cleanup.yml:delete-preview"
breaks "pull-requests: write at ci.yml's top level" ci.yml \
  '.permissions["pull-requests"] = "write"' "at the top level of: ci.yml"
breaks "the comment job given a secret" ci.yml \
  "$comment"'.steps[1].env.TOKEN = "${{ secrets.CLOUDFLARE_API_TOKEN }}"' "preview-comment uses a secret"
breaks "the comment job given id-token: write" ci.yml \
  "$comment"'.permissions["id-token"] = "write"' "nothing more"
breaks "the comment job checking out the pull request's head" ci.yml \
  "$comment"'.steps[0].with.ref = "${{ github.event.pull_request.head.sha }}"' "checks out something other than the base commit"
breaks "the comment job checking out the default (the pull request's merge commit)" ci.yml \
  "del($comment"'.steps[0].with.ref)' "checks out something other than the base commit"
breaks "the comment job running on every event" ci.yml \
  "$comment"'.if = "${{ !cancelled() }}"' "condition is not the previews'"
breaks "the comment job running before the api's preview" ci.yml \
  "$comment"'.needs = ["preview"]' "doesn't need both previews"
breaks "ci-passed needing the comment job" ci.yml \
  '.jobs["ci-passed"].needs += ["preview-comment"]' "needed by: ci.yml:ci-passed"

if [ "$failures" -gt 0 ]; then
  echo "tests/check-workflows.sh: $failures case(s) failed."
  exit 1
fi
echo "tests/check-workflows.sh: the workflows pass, and each broken rule fails the check."
