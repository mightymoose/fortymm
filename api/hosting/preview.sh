#!/usr/bin/env bash
# preview.sh <service> <local image> <tag>
#
# Deploys a preview of the api, as the deployer, in the api-hosting container.
# api:preview runs it, after building <local image> (the production image,
# api/Dockerfile, for linux/amd64) on the host:
#
# 1. pushes the image to its own package, <IMAGE_REPOSITORY>/<package>:<tag>;
# 2. creates the preview's database on the shared instance, if it doesn't
#    exist (a redeploy keeps it, and its data);
# 3. deploys the Cloud Run service, pinned to the image's digest, so a
#    redeploy always serves the build it just pushed;
# 4. prints the service's address and the digest it serves.
#
# The database and package come from the service's name (preview-name.sh):
# fortymm-api-pr-9 gets pr_9 and pr-9, and no two names share either.
set -euo pipefail

here=$(dirname "$0")
service="${1:-}"
local_image="${2:?usage: preview.sh <service> <local image> <tag>}"
tag="${3:?usage: preview.sh <service> <local image> <tag>}"
read -r database package < <(sh "$here/preview-name.sh" "$service")

# shellcheck source=credentials.sh
. "$here/credentials.sh" api:preview
# shellcheck source=exists.sh
. "$here/exists.sh"

registry="$REGION-docker.pkg.dev"
image="$registry/$PROJECT/$IMAGE_REPOSITORY/$package:$tag"
connection="$PROJECT:$REGION:$INSTANCE"

echo "api:preview: pushing $image"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://$registry" >/dev/null 2>&1
docker tag "$local_image" "$image"
push_log=$(docker push "$image")
digest=$(grep -Eo 'digest: sha256:[0-9a-f]{64}' <<<"$push_log" | tail -n 1 | cut -d' ' -f2)
docker rmi "$image" >/dev/null
if [ -z "$digest" ]; then
  echo "api:preview: pushed, but found no digest in docker push's output:" >&2
  echo "$push_log" >&2
  exit 1
fi

# Created only when gcloud says not found; any other failure stops here.
if exists api:preview "HTTPError 404" sql databases describe "$database" --instance="$INSTANCE"; then
  echo "api:preview: the database $database exists; keeping it."
else
  echo "api:preview: creating the database $database on $INSTANCE"
  gcloud sql databases create "$database" --instance="$INSTANCE" --quiet >/dev/null
fi

echo "api:preview: deploying $service ($image@$digest)"
# DATABASE_URL names no host: the socket's directory in host, the user in user,
# and the password in PGPASSWORD, from Secret Manager. ^@^ makes @ the list
# separator, since the value holds & and =.
gcloud run deploy "$service" --quiet \
  --region="$REGION" \
  --image="$registry/$PROJECT/$IMAGE_REPOSITORY/$package@$digest" \
  --port=8000 \
  --service-account="$RUNTIME" \
  --add-cloudsql-instances="$connection" \
  --set-env-vars="^@^DATABASE_URL=postgresql:///$database?host=/cloudsql/$connection&user=$DATABASE_USER" \
  --set-secrets="PGPASSWORD=$PASSWORD_SECRET:latest" \
  --labels="preview=$package" \
  --no-invoker-iam-check \
  --min-instances=0 --max-instances=1 \
  2>&1 | grep -v -e "^WARNING: This command is using service account impersonation" -e "^Skipped validating Cloud SQL API"

# The address made from the service's name, which Cloud Run lists beside an
# older random one: https://<service>-<project number>.<region>.run.app.
address="https://$service-$PROJECT_NUMBER.$REGION.run.app"
urls=$(gcloud run services describe "$service" --region="$REGION" \
  --format='value(metadata.annotations["run.googleapis.com/urls"])')
if ! grep -qF "\"$address\"" <<<"$urls"; then
  echo "api:preview: deployed, but Cloud Run doesn't list $address among its addresses: $urls" >&2
  exit 1
fi
served=$(gcloud run services describe "$service" --region="$REGION" \
  --format='value(spec.template.spec.containers[0].image)')
echo "api:preview: $service serves $served"
echo "api:preview: address $address"
