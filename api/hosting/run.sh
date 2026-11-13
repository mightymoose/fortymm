#!/bin/sh
# run.sh <command...>
#
# Runs a command in the api-hosting container, without a terminal, with
# gcloud's credentials: in CI, the credential file google-github-actions/auth
# wrote (CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE, a path on the runner), mounted
# read-only and named to gcloud; elsewhere, the login kept in the
# api-hosting-gcloud volume. The api:preview and api:preview-delete tasks run
# it on the host, with the Compose settings mise gives them.
set -eu

if [ -n "${CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:-}" ]; then
  exec docker compose --profile tools run --rm -T \
    -v "$CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE:/run/gcloud/credentials.json:ro" \
    -e CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE=/run/gcloud/credentials.json \
    api-hosting "$@"
fi
exec docker compose --profile tools run --rm -T api-hosting "$@"
