#!/usr/bin/env bash
# delete-preview.sh <service>
#
# Deletes a pull request's preview, as the deployer, in the api-hosting
# container: the Cloud Run service first (so nothing holds the database open),
# then its database, then its image package with every version in it (the
# tagged images and their untagged manifests). Only ever fortymm-api-pr-<number>
# (preview-name.sh --deletable, which api:preview-delete also runs on the host
# before the container starts). Something already gone is not an error.
set -euo pipefail

here=$(dirname "$0")
service="${1:-}"
read -r database package < <(sh "$here/preview-name.sh" --deletable "$@")

# shellcheck source=credentials.sh
. "$here/credentials.sh" api:preview-delete

quiet() { grep -v -e "^WARNING: This command is using service account impersonation" || true; }

if gcloud run services describe "$service" --region="$REGION" >/dev/null 2>&1; then
  gcloud run services delete "$service" --region="$REGION" --quiet 2>&1 | quiet
  echo "api:preview-delete: deleted the service $service."
else
  echo "api:preview-delete: no service $service; nothing to delete."
fi

if gcloud sql databases describe "$database" --instance="$INSTANCE" >/dev/null 2>&1; then
  # The service's last instance can hold a connection for some seconds after
  # the service is gone, and a database in use can't be dropped.
  for attempt in 1 2 3 4 5 6; do
    if out=$(gcloud sql databases delete "$database" --instance="$INSTANCE" --quiet 2>&1); then
      echo "api:preview-delete: deleted the database $database."
      break
    fi
    if [ "$attempt" = 6 ]; then
      echo "$out" >&2
      exit 1
    fi
    echo "api:preview-delete: the database $database can't be dropped yet; trying again in 20 seconds."
    sleep 20
  done
else
  echo "api:preview-delete: no database $database; nothing to delete."
fi

if gcloud artifacts packages describe "$package" --repository="$IMAGE_REPOSITORY" --location="$REGION" >/dev/null 2>&1; then
  gcloud artifacts packages delete "$package" --repository="$IMAGE_REPOSITORY" --location="$REGION" --quiet 2>&1 | quiet
  echo "api:preview-delete: deleted the image package $package, every version in it."
else
  echo "api:preview-delete: no image package $package; nothing to delete."
fi
