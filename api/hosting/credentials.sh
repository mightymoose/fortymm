#!/bin/sh
# credentials.sh <task name>
#
# Sourced by preview.sh and delete-preview.sh, in the api-hosting container:
# makes gcloud act as the deployer, and stops, saying what is missing, unless
# it can get the deployer's token. Nothing in Google Cloud is read or changed
# before this.
#
# - In CI, google-github-actions/auth gives the deployer's credentials through
#   Workload Identity Federation: a credential file, which the api:preview and
#   api:preview-delete tasks mount and name in
#   CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE. No key is stored anywhere.
# - On a laptop, the owner's login (api:gcloud -- auth login) impersonates the
#   deployer (the setup lets the owner who ran it do that), so a preview made
#   by hand is made with the deployer's roles, never the owner's.

# shellcheck source=hosting.env
. "$(dirname "$0")/hosting.env"
export CLOUDSDK_CORE_PROJECT="$PROJECT"
if [ -z "${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-}" ]; then
  export CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT="$DEPLOYER"
fi

if ! gcloud auth print-access-token >/dev/null 2>&1; then
  echo "$1: missing credentials: gcloud can't act as $DEPLOYER, so nothing was read or changed." >&2
  echo "In CI, google-github-actions/auth must run first (ci.yml's preview (api) job)." >&2
  echo "On a laptop, log in as an owner who ran api:hosting-setup:" >&2
  echo "  ./bin/mise run api:gcloud -- auth login --no-launch-browser" >&2
  exit 1
fi
