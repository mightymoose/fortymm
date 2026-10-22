#!/usr/bin/env bash
# One-time Google Cloud setup for deploying the API from GitHub Actions (see
# api/deploy/README.md). Run it once, as a project owner, with gcloud logged
# in (`gcloud auth login`); it's safe to re-run. It prints the GitHub Actions
# variables to set at the end.
#
#   api/deploy/bootstrap-gcp.sh [--cleanup-dry-run] [PROJECT_ID] [REGION]
#
# Defaults match mise.toml's GCP_PROJECT and GCP_REGION. --cleanup-dry-run
# applies the image cleanup policy in Artifact Registry's dry-run mode (it
# logs what it would delete, and deletes nothing); without it the policy is
# enforced.
set -euo pipefail

cleanup_mode=--no-dry-run
if [ "${1:-}" = --cleanup-dry-run ]; then
  cleanup_mode=--dry-run
  shift
fi
project=${1:-fortymm}
region=${2:-us-central1}
github_repo=mightymoose/fortymm
registry_repo=fortymm   # Artifact Registry repository; the image is <repo>/api
deployer=github-deployer
runtime=api-runtime
pool=github
provider=github
worker_secret=api-worker-secret

deployer_sa="$deployer@$project.iam.gserviceaccount.com"
runtime_sa="$runtime@$project.iam.gserviceaccount.com"
gc() { gcloud --project "$project" --quiet "$@"; }

apis=(
  run.googleapis.com
  artifactregistry.googleapis.com
  iam.googleapis.com
  iamcredentials.googleapis.com
  sts.googleapis.com
  secretmanager.googleapis.com
  billingbudgets.googleapis.com
)
echo "Enabling APIs in $project..."
gc services enable "${apis[@]}"

# `services enable` can return before an API answers requests, so poll a
# read-only call for each one the steps below use. An API added to $apis
# without a case here stops the script.
api_ready() {
  case $1 in
    run.googleapis.com) gc run services list --region "$region" ;;
    artifactregistry.googleapis.com) gc artifacts repositories list --location "$region" ;;
    iam.googleapis.com)
      gc iam service-accounts list && gc iam workload-identity-pools list --location global ;;
    secretmanager.googleapis.com) gc secrets list ;;
    billingbudgets.googleapis.com)
      # Without a billing account there's nothing to poll. The budget step
      # reports it.
      local account
      account=$(gcloud billing projects describe "$project" --format='value(billingAccountName)') ||
        return
      [ -z "$account" ] || gcloud billing budgets list --billing-account "${account#billingAccounts/}" \
        --billing-project "$project" --quiet ;;
    # Only CI's Workload Identity login uses these.
    iamcredentials.googleapis.com | sts.googleapis.com) ;;
    *) echo "No readiness check for $1."; return 2 ;;
  esac
}
wait_for() {
  local retries=0 status out   # every 5 seconds, about 2 minutes in all
  while :; do
    status=0
    out=$(api_ready "$1" 2>&1) || status=$?
    [ "$status" -ne 0 ] || return 0
    # 2 is also gcloud's exit status for a bad command line. Waiting can't fix
    # either.
    if [ "$status" -eq 2 ]; then
      echo "$out" >&2
      return 1
    fi
    if [ "$retries" -ge 24 ]; then
      printf '%s\n%s is still not usable after about 2 minutes. Re-running this script is safe.\n' \
        "$out" "$1" >&2
      return 1
    fi
    [ "$retries" -gt 0 ] || echo "Waiting for $1..."
    retries=$((retries + 1))
    sleep 5
  done
}
# In parallel, so a re-run, where every API is ready, waits for one call.
pids=()
for service in "${apis[@]}"; do
  wait_for "$service" &
  pids+=($!)
done
not_ready=0
for pid in "${pids[@]}"; do
  wait "$pid" || not_ready=1
done
[ "$not_ready" -eq 0 ] || exit 1

project_number=$(gcloud projects describe "$project" --format='value(projectNumber)')

echo "Creating the Artifact Registry repository $registry_repo in $region..."
gc artifacts repositories describe "$registry_repo" --location "$region" >/dev/null 2>&1 ||
  gc artifacts repositories create "$registry_repo" --location "$region" \
    --repository-format docker --description "FortyMM container images"

# cloud-run-deploy moves the `production` tag to each image it deploys to the
# `api` service, and the cleanup policy keeps whatever it points at. Point it
# at the image production serves now (which may predate the tag, or be a
# rollback), so applying the policy can't delete it.
serving=$(gc run services describe api --region "$region" \
  --flatten status.traffic --format 'value(status.traffic.percent,status.traffic.revisionName)' \
  2>/dev/null | sort -rn | head -n 1 | cut -f 2 || true)
if [ -n "$serving" ]; then
  serving_image=$(gc run revisions describe "$serving" --region "$region" \
    --format 'value(status.imageDigest)')
  echo "Tagging $serving_image (revision $serving) as production..."
  gc artifacts docker tags add "$serving_image" "${serving_image%@*}:production"
fi

echo "Applying the cleanup policy to $registry_repo ($cleanup_mode)..."
gc artifacts repositories set-cleanup-policies "$registry_repo" --location "$region" \
  --policy "$(dirname "$0")/cleanup-policy.json" "$cleanup_mode" >/dev/null

echo "Creating the service accounts..."
gc iam service-accounts describe "$deployer_sa" >/dev/null 2>&1 ||
  gc iam service-accounts create "$deployer" --display-name "GitHub Actions deployer ($github_repo)"
# The API runs as this account. Its only grant is reading the Worker secret.
gc iam service-accounts describe "$runtime_sa" >/dev/null 2>&1 ||
  gc iam service-accounts create "$runtime" --display-name "FortyMM API (Cloud Run)"

echo "Granting the deployer its roles..."
for role in roles/run.admin roles/artifactregistry.writer; do
  gc projects add-iam-policy-binding "$project" \
    --member "serviceAccount:$deployer_sa" --role "$role" --condition None >/dev/null
done
# Moving the `production` tag to a new image deletes it from the old one,
# which roles/artifactregistry.writer can't do.
gc artifacts repositories add-iam-policy-binding "$registry_repo" --location "$region" \
  --member "serviceAccount:$deployer_sa" --role roles/artifactregistry.repoAdmin >/dev/null
# Deploying a service that runs as $runtime_sa means acting as it.
gc iam service-accounts add-iam-policy-binding "$runtime_sa" \
  --member "serviceAccount:$deployer_sa" --role roles/iam.serviceAccountUser >/dev/null

echo "Creating the Worker secret $worker_secret..."
# The API requires it in the X-FortyMM-Worker-Secret header, which only the
# Cloudflare Worker sends. tr drops openssl's newline, which Cloud Run would
# keep in the API's WORKER_SECRET.
gc secrets describe "$worker_secret" >/dev/null 2>&1 ||
  openssl rand -hex 32 | tr -d '\n' |
  gc secrets create "$worker_secret" --replication-policy automatic --data-file=- >/dev/null
# The API reads it at start, and CI reads it to deploy the Worker.
for sa in "$runtime_sa" "$deployer_sa"; do
  gc secrets add-iam-policy-binding "$worker_secret" \
    --member "serviceAccount:$sa" --role roles/secretmanager.secretAccessor >/dev/null
done
# Lets CI list the versions, to pin the newest one for both deploys.
gc secrets add-iam-policy-binding "$worker_secret" \
  --member "serviceAccount:$deployer_sa" --role roles/secretmanager.viewer >/dev/null

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

echo "Creating the monthly budget..."
billing_account=$(gcloud billing projects describe "$project" --format='value(billingAccountName)')
: "${billing_account:?$project has no billing account}"
budget_name="FortyMM ($project)"
# The Budget API needs a quota project when gcloud runs as a user.
budgets() {
  gcloud billing budgets "$@" --billing-account "${billing_account#billingAccounts/}" \
    --billing-project "$project" --quiet
}
if [ -z "$(budgets list --filter "displayName=\"$budget_name\"" --format='value(name)')" ]; then
  # No recipients are set, so the billing account's admins and users get the
  # emails, at $10 (40%) and $25 of the month's spend.
  budgets create --display-name "$budget_name" --budget-amount 25USD \
    --filter-projects "projects/$project" --calendar-period month \
    --threshold-rule percent=0.4 --threshold-rule percent=1.0 >/dev/null
fi

cat <<DONE

Done. Add these GitHub Actions variables to $github_repo (Settings > Secrets
and variables > Actions > Variables), or run:

  gh variable set GCP_WORKLOAD_IDENTITY_PROVIDER --repo $github_repo \\
    --body projects/$project_number/locations/global/workloadIdentityPools/$pool/providers/$provider
  gh variable set GCP_SERVICE_ACCOUNT --repo $github_repo --body $deployer_sa

The next CI run deploys the API: production from main, a tagged revision of
api-preview from any other branch. The production URL will be
https://api-$project_number.$region.run.app.

The Worker secret is in Secret Manager as $worker_secret. CI gives it to the
API and the Worker, so it never needs to be copied by hand.

The budget "$budget_name" emails the billing account's admins and users when
the month's spend passes \$10 and \$25.
DONE
