#!/usr/bin/env bash
# One-time Google Cloud setup for deploying the API from GitHub Actions (see
# api/deploy/README.md). Run it once, as a project owner, with gcloud logged
# in (`gcloud auth login`); it's safe to re-run. It prints the GitHub Actions
# variables to set at the end.
#
#   api/deploy/bootstrap-gcp.sh [PROJECT_ID] [REGION]
#
# Defaults match mise.toml's GCP_PROJECT and GCP_REGION.
set -euo pipefail

project=${1:-fortymm}
region=${2:-us-central1}
github_repo=mightymoose/fortymm
registry_repo=fortymm   # Artifact Registry repository; the image is <repo>/api
deployer=github-deployer
runtime=api-runtime
pool=github
provider=github

deployer_sa="$deployer@$project.iam.gserviceaccount.com"
runtime_sa="$runtime@$project.iam.gserviceaccount.com"
gc() { gcloud --project "$project" --quiet "$@"; }

echo "Enabling APIs in $project..."
gc services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com

project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')

echo "Creating the Artifact Registry repository $registry_repo in $region..."
gc artifacts repositories describe "$registry_repo" --location "$region" >/dev/null 2>&1 ||
  gc artifacts repositories create "$registry_repo" --location "$region" \
    --repository-format docker --description "FortyMM container images"

echo "Creating the service accounts..."
gc iam service-accounts describe "$deployer_sa" >/dev/null 2>&1 ||
  gc iam service-accounts create "$deployer" --display-name "GitHub Actions deployer ($github_repo)"
# The API runs as this account, which has no roles: it needs no Google APIs yet.
gc iam service-accounts describe "$runtime_sa" >/dev/null 2>&1 ||
  gc iam service-accounts create "$runtime" --display-name "FortyMM API (Cloud Run)"

echo "Granting the deployer its roles..."
for role in roles/run.admin roles/artifactregistry.writer; do
  gc projects add-iam-policy-binding "$project" \
    --member "serviceAccount:$deployer_sa" --role "$role" --condition None >/dev/null
done
# Deploying a service that runs as $runtime_sa means acting as it.
gc iam service-accounts add-iam-policy-binding "$runtime_sa" \
  --member "serviceAccount:$deployer_sa" --role roles/iam.serviceAccountUser >/dev/null

echo "Creating the Workload Identity pool and provider for $github_repo..."
gc iam workload-identity-pools describe "$pool" --location global >/dev/null 2>&1 ||
  gc iam workload-identity-pools create "$pool" --location global --display-name "GitHub Actions"
# Only tokens from this repository's workflows (any branch: CI deploys every
# branch as a Preview) are accepted.
gc iam workload-identity-pools providers describe "$provider" \
  --location global --workload-identity-pool "$pool" >/dev/null 2>&1 ||
  gc iam workload-identity-pools providers create-oidc "$provider" \
    --location global --workload-identity-pool "$pool" \
    --display-name "GitHub Actions" \
    --issuer-uri https://token.actions.githubusercontent.com \
    --attribute-mapping 'google.subject=assertion.sub,attribute.repository=assertion.repository' \
    --attribute-condition "assertion.repository == '$github_repo'"
gc iam service-accounts add-iam-policy-binding "$deployer_sa" \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$project_number/locations/global/workloadIdentityPools/$pool/attribute.repository/$github_repo" \
  >/dev/null

cat <<DONE

Done. Add these GitHub Actions variables to $github_repo (Settings > Secrets
and variables > Actions > Variables), or run:

  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo $github_repo \\
    --body projects/$project_number/locations/global/workloadIdentityPools/$pool/providers/$provider
  gh variable set GCP_SERVICE_ACCOUNT --repo $github_repo --body $deployer_sa

The next CI run deploys the API: production from main, a tagged revision of
api-preview from any other branch. The production URL will be
https://api-$project_number.$region.run.app.
DONE
