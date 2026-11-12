#!/usr/bin/env bash
# setup.sh [--check]
#
# Prepares the Google Cloud project for the api's pull request previews: each
# pull request gets a Cloud Run service (fortymm-api-pr-<number>) and its own
# database (pr_<number>) on one shared Cloud SQL instance, deployed by GitHub
# Actions through Workload Identity Federation, with no stored key.
# api/README.md, "Hosting", lists everything it makes and why.
#
# Without --check (api:hosting-setup): creates what is missing and changes
# nothing that is already in place, then says what it did. Running it again
# changes nothing. Something that exists but differs from what is below (an
# instance of another tier, a role too many) is reported, never changed, and
# fails the run.
#
# With --check (api:hosting-check): changes nothing. Reports every item as in
# place, missing or different, then proves, as the deployer, what it can and
# cannot do. Fails if anything is missing or wrong.
#
# Either way it stops before touching anything when gcloud has no credentials.
# Run it with an owner's login: ./bin/mise run api:gcloud -- auth login.
set -euo pipefail

# ---- What the project holds. Change a value here, and nowhere else. --------
# Everything here is for previews only, and named so: production will get its
# own instance, role, secret and accounts beside these, and none of these
# grants reach them.
PROJECT=fortymm
REGION=northamerica-northeast2

# Who may deploy: GitHub Actions in this repository, and nothing else. The
# numeric ID survives a rename and can't be taken by a new repository of the
# same name (gh api repos/mightymoose/fortymm --jq .id).
GITHUB_REPOSITORY=mightymoose/fortymm
GITHUB_REPOSITORY_ID=1451920058

# The shared PostgreSQL instance. db-f1-micro is the smallest shared-core
# tier (Enterprise edition only). One zone, no high availability, no backups:
# preview data is thrown away with its pull request.
INSTANCE="fortymm-api-preview"
DATABASE_VERSION=POSTGRES_18
TIER=db-f1-micro
STORAGE_GB=10

# The one database role every preview connects as, and the secret holding its
# password. Previews are separated by database, not by role.
DATABASE_USER=api_preview
PASSWORD_SECRET="api-preview-database-password"

# Where the previews' images go.
IMAGE_REPOSITORY="fortymm-api-preview"

# The previews' Cloud Run services are named $SERVICE_PREFIX<something>
# (CI: fortymm-api-pr-<number>); the deployer may touch no other service.
SERVICE_PREFIX="fortymm-api-pr-"

# What GitHub Actions becomes (the deployer), and what the services run as.
DEPLOYER="api-preview-deployer"
RUNTIME="api-preview-runtime"
# The deployer's two custom roles, one per kind of resource it touches.
DATABASES_ROLE=apiPreviewDatabases
SERVICES_ROLE=apiPreviewServices

WORKLOAD_IDENTITY_POOL=github-actions
WORKLOAD_IDENTITY_PROVIDER=fortymm

APIS="artifactregistry.googleapis.com
cloudresourcemanager.googleapis.com
iam.googleapis.com
iamcredentials.googleapis.com
run.googleapis.com
secretmanager.googleapis.com
sqladmin.googleapis.com
sts.googleapis.com"

# The deployer's roles. Databases: create and drop databases on the preview
# instance, not the instance itself, its users or its settings. Services:
# deploy, make public and delete the preview services.
DATABASES_PERMISSIONS="cloudsql.databases.create
cloudsql.databases.delete
cloudsql.databases.get
cloudsql.databases.list
cloudsql.instances.get"
SERVICES_PERMISSIONS="run.operations.get
run.services.create
run.services.delete
run.services.get
run.services.getIamPolicy
run.services.list
run.services.setIamPolicy
run.services.update"

# What the deployer must never be able to do. --check asks Google Cloud, as
# the deployer, and fails if any of these is granted.
DEPLOYER_MUST_NOT="cloudsql.instances.delete
cloudsql.instances.update
cloudsql.instances.create
cloudsql.users.update
cloudsql.users.create
resourcemanager.projects.setIamPolicy
iam.serviceAccountKeys.create
secretmanager.versions.access"

# ---- Derived names ---------------------------------------------------------
DEPLOYER_EMAIL="$DEPLOYER@$PROJECT.iam.gserviceaccount.com"
RUNTIME_EMAIL="$RUNTIME@$PROJECT.iam.gserviceaccount.com"
DATABASES_ROLE_NAME="projects/$PROJECT/roles/$DATABASES_ROLE"
SERVICES_ROLE_NAME="projects/$PROJECT/roles/$SERVICES_ROLE"
CONNECTION_NAME="$PROJECT:$REGION:$INSTANCE"
# IAM conditions that narrow a project-level grant to the preview resources.
# Cloud SQL's IAM is per project, and a condition on the instance's name is
# the only way to narrow it. Cloud Run's create is checked on the region, not
# on a service, so the services role can't be narrowed by name (README,
# "Hosting").
INSTANCE_CONDITION="resource.name == 'projects/$PROJECT/instances/$INSTANCE' && resource.service == 'sqladmin.googleapis.com'"
export CLOUDSDK_CORE_PROJECT="$PROJECT"

# ---- Mode and output -------------------------------------------------------
mode=setup
case "${1:-}" in
  '') ;;
  --check) mode=check ;;
  *) echo "usage: setup.sh [--check]" >&2; exit 2 ;;
esac
name="api:hosting-$mode"
changes=0
problems=0

in_place() { echo "  in place  $*"; }
made() { echo "  created   $*"; changes=$((changes + 1)); }
missing() { echo "  MISSING   $*" >&2; problems=$((problems + 1)); }
differs() { echo "  DIFFERS   $*" >&2; problems=$((problems + 1)); }
section() { echo; echo "$*"; }
quietly() { "$@" >/dev/null 2>&1; }

# ensure <what> <test command> <create function>: in place if the test
# passes; otherwise missing (--check) or created.
ensure() {
  local what=$1 test=$2 create=$3
  if eval "$test" >/dev/null 2>&1; then
    in_place "$what"
  elif [ "$mode" = check ]; then
    missing "$what"
  else
    "$create"
    made "$what"
  fi
}

# A new service account can take some seconds to be visible to IAM.
retry() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then return 0; fi
    [ "$attempt" = 6 ] || sleep 10
  done
  return 1
}

# Calls a Google API with gcloud's token (optionally as another identity),
# without putting the token in any command's arguments. The body, if any,
# comes from standard input.
api_call() {
  local method=$1 url=$2 impersonate=${3:-} headers token
  headers=$(mktemp)
  if [ -n "$impersonate" ]; then
    token=$(gcloud auth print-access-token --impersonate-service-account="$impersonate" 2>/dev/null) || { rm -f "$headers"; return 1; }
  else
    token=$(gcloud auth print-access-token 2>/dev/null) || { rm -f "$headers"; return 1; }
  fi
  printf 'Authorization: Bearer %s\nContent-Type: application/json\n' "$token" >"$headers"
  if [ "$method" = GET ]; then
    curl --silent --show-error --fail-with-body -H @"$headers" "$url"
  else
    curl --silent --show-error --fail-with-body -X "$method" -H @"$headers" --data-binary @- "$url"
  fi
  local status=$?
  rm -f "$headers"
  return $status
}

# ---- Credentials, before anything else -------------------------------------
if ! quietly gcloud auth print-access-token; then
  echo "$name: gcloud has no credentials, so nothing was read or changed." >&2
  echo "Log in with an owner of the project $PROJECT first:" >&2
  echo "  ./bin/mise run api:gcloud -- auth login" >&2
  exit 1
fi
account=$(gcloud config get-value account 2>/dev/null || true)
if ! number=$(gcloud projects describe "$PROJECT" --format='value(projectNumber)' 2>/dev/null) || [ -z "$number" ]; then
  echo "$name: ${account:-this login} can't see the project '$PROJECT'. Is that its ID? gcloud projects list shows the ones it can." >&2
  exit 1
fi
PRINCIPAL_SET="principalSet://iam.googleapis.com/projects/$number/locations/global/workloadIdentityPools/$WORKLOAD_IDENTITY_POOL/attribute.repository/$GITHUB_REPOSITORY"
PROVIDER_NAME="projects/$number/locations/global/workloadIdentityPools/$WORKLOAD_IDENTITY_POOL/providers/$WORKLOAD_IDENTITY_PROVIDER"
ATTRIBUTE_CONDITION="assertion.repository_id == '$GITHUB_REPOSITORY_ID' && assertion.repository == '$GITHUB_REPOSITORY'"
echo "$name: project $PROJECT ($number), region $REGION, as ${account:-the active credentials}"

# ---- APIs --------------------------------------------------------------------
section "APIs"
enabled=$(gcloud services list --enabled --format='value(config.name)')
to_enable=""
for api in $APIS; do
  if grep -qx "$api" <<<"$enabled"; then
    in_place "$api"
  elif [ "$mode" = check ]; then
    missing "$api"
  else
    to_enable="$to_enable $api"
  fi
done
if [ -n "$to_enable" ]; then
  # shellcheck disable=SC2086
  gcloud services enable $to_enable --quiet
  for api in $to_enable; do made "$api"; done
fi

# ---- Service accounts --------------------------------------------------------
section "Service accounts"
create_deployer() {
  gcloud iam service-accounts create "$DEPLOYER" --quiet \
    --display-name="api preview deployer" \
    --description="What GitHub Actions in $GITHUB_REPOSITORY becomes: deploys and deletes the api's pull request previews."
}
create_runtime() {
  gcloud iam service-accounts create "$RUNTIME" --quiet \
    --display-name="api preview runtime" \
    --description="What the api's pull request previews run as: connects to the shared instance, reads the database password."
}
ensure "$DEPLOYER_EMAIL" "gcloud iam service-accounts describe $DEPLOYER_EMAIL" create_deployer
ensure "$RUNTIME_EMAIL" "gcloud iam service-accounts describe $RUNTIME_EMAIL" create_runtime

# ---- The deployer's roles ----------------------------------------------------
section "Custom roles"
# custom_role <id> <title> <permissions>: the role exists, with exactly these
# permissions. The script owns these roles, so it sets their permissions.
custom_role() {
  local id=$1 title=$2 wanted state have
  wanted=$(sort <<<"$3")
  local what="role projects/$PROJECT/roles/$id"
  state=$(gcloud iam roles describe "$id" --project="$PROJECT" --format='value(deleted)' 2>/dev/null || echo absent)
  if [ "$state" = absent ]; then
    if [ "$mode" = check ]; then missing "$what"; return; fi
    gcloud iam roles create "$id" --project="$PROJECT" --quiet --title="$title" --stage=GA \
      --permissions="$(paste -sd, <<<"$wanted")" >/dev/null
    made "$what, exactly: $(paste -sd' ' <<<"$wanted")"
    return
  fi
  if [ "$state" = True ]; then
    # A deleted role keeps its ID for 7 days, and can't be made again under it.
    if [ "$mode" = check ]; then missing "$what (deleted)"; return; fi
    gcloud iam roles undelete "$id" --project="$PROJECT" --quiet >/dev/null
    made "$what (undeleted)"
  fi
  have=$(gcloud iam roles describe "$id" --project="$PROJECT" --format='value(includedPermissions)' | tr ';' '\n' | sort)
  if [ "$have" = "$wanted" ]; then
    in_place "$what, exactly: $(paste -sd' ' <<<"$wanted")"
  elif [ "$mode" = check ]; then
    differs "$what has: $(paste -sd' ' <<<"$have")"
  else
    gcloud iam roles update "$id" --project="$PROJECT" --quiet --permissions="$(paste -sd, <<<"$wanted")" >/dev/null
    made "$what's permissions, now exactly: $(paste -sd' ' <<<"$wanted")"
  fi
}
custom_role "$DATABASES_ROLE" "api preview databases" "$DATABASES_PERMISSIONS"
custom_role "$SERVICES_ROLE" "api preview services" "$SERVICES_PERMISSIONS"

# ---- Artifact Registry -------------------------------------------------------
section "Artifact Registry"
create_repository() {
  gcloud artifacts repositories create "$IMAGE_REPOSITORY" --location="$REGION" --quiet \
    --repository-format=docker \
    --description="The api's images, one per pull request preview." >/dev/null 2>&1
}
ensure "repository $REGION-docker.pkg.dev/$PROJECT/$IMAGE_REPOSITORY" \
  "gcloud artifacts repositories describe $IMAGE_REPOSITORY --location=$REGION" create_repository

# ---- Cloud SQL -----------------------------------------------------------------
section "Cloud SQL"
create_instance() {
  echo "  creating the instance $INSTANCE; this takes several minutes..."
  local operation
  operation=$(gcloud sql instances create "$INSTANCE" --quiet --async --format='value(name)' \
    --database-version="$DATABASE_VERSION" \
    --edition=enterprise \
    --tier="$TIER" \
    --region="$REGION" \
    --availability-type=zonal \
    --storage-type=SSD \
    --storage-size="$STORAGE_GB" \
    --no-backup \
    --deletion-protection \
    --connector-enforcement=REQUIRED)
  gcloud sql operations wait "$operation" --timeout=unlimited --quiet >/dev/null
}
ensure "instance $CONNECTION_NAME" "gcloud sql instances describe $INSTANCE" create_instance
if quietly gcloud sql instances describe "$INSTANCE"; then
  # What must hold of the instance; reported, never changed by this script.
  instance=$(gcloud sql instances describe "$INSTANCE" --format='value[separator=" "](databaseVersion,settings.tier,settings.edition,settings.availabilityType,region,settings.deletionProtectionEnabled,settings.connectorEnforcement)')
  expected="$DATABASE_VERSION $TIER ENTERPRISE ZONAL $REGION True REQUIRED"
  if [ "$instance" = "$expected" ]; then
    in_place "instance settings: $instance"
  else
    differs "instance settings are '$instance', expected '$expected' (not changed by this script)"
  fi
fi

# ---- The database role and its password ---------------------------------------
section "Database role and password"
create_secret() {
  gcloud secrets create "$PASSWORD_SECRET" --quiet \
    --replication-policy=user-managed --locations="$REGION" >/dev/null 2>&1
}
ensure "secret $PASSWORD_SECRET" "gcloud secrets describe $PASSWORD_SECRET" create_secret

# The password is generated here, goes to Secret Manager first and to the
# instance second, and is never printed: it passes through variables and
# pipes only, never a command's arguments or a file.
has_version=""
if quietly gcloud secrets describe "$PASSWORD_SECRET" &&
  [ -n "$(gcloud secrets versions list "$PASSWORD_SECRET" --filter='state=ENABLED' --limit=1 --format='value(name)' 2>/dev/null)" ]; then
  has_version=1
fi
has_user=""
if quietly gcloud sql instances describe "$INSTANCE" &&
  gcloud sql users list --instance="$INSTANCE" --format='value(name)' 2>/dev/null | grep -qx "$DATABASE_USER"; then
  has_user=1
fi

user_body() {
  local password=$1
  printf '{"name": "%s", "password": "%s"}' "$DATABASE_USER" "$password"
}
wait_for_sql_operation() {
  local response=$1 operation
  operation=$(sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' <<<"$response" | head -n 1)
  gcloud sql operations wait "$operation" --timeout=unlimited --quiet >/dev/null
}
users_url="https://sqladmin.googleapis.com/v1/projects/$PROJECT/instances/$INSTANCE/users"

if [ -n "$has_version" ]; then
  in_place "the password, in $PASSWORD_SECRET"
elif [ "$mode" = check ]; then
  missing "the password, in $PASSWORD_SECRET"
else
  password=$(openssl rand -hex 32)
  printf '%s' "$password" | gcloud secrets versions add "$PASSWORD_SECRET" --data-file=- --quiet >/dev/null 2>&1
  made "the password, in $PASSWORD_SECRET"
  if [ -n "$has_user" ]; then
    # The role exists with a password nobody kept: give it the new one.
    response=$(user_body "$password" | api_call PUT "$users_url?name=$DATABASE_USER")
    wait_for_sql_operation "$response"
    made "the password of the database role $DATABASE_USER (set to the new one)"
  fi
  unset password
fi

if [ -n "$has_user" ]; then
  in_place "database role $DATABASE_USER"
elif [ "$mode" = check ]; then
  missing "database role $DATABASE_USER"
else
  password=$(gcloud secrets versions access latest --secret="$PASSWORD_SECRET" 2>/dev/null)
  response=$(user_body "$password" | api_call POST "$users_url")
  unset password
  wait_for_sql_operation "$response"
  made "database role $DATABASE_USER, with the password in $PASSWORD_SECRET"
fi

# ---- Workload Identity Federation ---------------------------------------------
section "Workload Identity Federation"
create_pool() {
  gcloud iam workload-identity-pools create "$WORKLOAD_IDENTITY_POOL" --location=global --quiet \
    --display-name="GitHub Actions" >/dev/null 2>&1
}
create_provider() {
  gcloud iam workload-identity-pools providers create-oidc "$WORKLOAD_IDENTITY_PROVIDER" --quiet \
    --location=global --workload-identity-pool="$WORKLOAD_IDENTITY_POOL" \
    --display-name="$GITHUB_REPOSITORY" \
    --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_id=assertion.repository_id" \
    --attribute-condition="$ATTRIBUTE_CONDITION" >/dev/null 2>&1
}
pool_state=$(gcloud iam workload-identity-pools describe "$WORKLOAD_IDENTITY_POOL" --location=global --format='value(state)' 2>/dev/null || true)
if [ "$pool_state" = DELETED ] && [ "$mode" = setup ]; then
  # A deleted pool keeps its ID for 30 days.
  gcloud iam workload-identity-pools undelete "$WORKLOAD_IDENTITY_POOL" --location=global --quiet >/dev/null
  made "pool $WORKLOAD_IDENTITY_POOL (undeleted)"
fi
ensure "pool $WORKLOAD_IDENTITY_POOL" \
  "[ \"\$(gcloud iam workload-identity-pools describe $WORKLOAD_IDENTITY_POOL --location=global --format='value(state)')\" = ACTIVE ]" create_pool
ensure "provider $PROVIDER_NAME" \
  "gcloud iam workload-identity-pools providers describe $WORKLOAD_IDENTITY_PROVIDER --location=global --workload-identity-pool=$WORKLOAD_IDENTITY_POOL" \
  create_provider
provider=$(gcloud iam workload-identity-pools providers describe "$WORKLOAD_IDENTITY_PROVIDER" \
  --location=global --workload-identity-pool="$WORKLOAD_IDENTITY_POOL" \
  --format='value[separator="|"](state,oidc.issuerUri,attributeCondition)' 2>/dev/null || true)
if [ -n "$provider" ]; then
  expected="ACTIVE|https://token.actions.githubusercontent.com|$ATTRIBUTE_CONDITION"
  if [ "$provider" = "$expected" ]; then
    in_place "provider condition: $ATTRIBUTE_CONDITION"
  else
    differs "provider is '$provider', expected '$expected' (not changed by this script)"
  fi
fi

# ---- Who may do what ------------------------------------------------------------
section "Role bindings"
# iam <verb> <kind> <resource> [flag...]: an IAM policy verb on a resource.
iam() {
  local verb=$1 kind=$2 resource=$3
  shift 3
  case "$kind" in
    project) gcloud projects "$verb" "$resource" "$@" ;;
    service-account) gcloud iam service-accounts "$verb" "$resource" "$@" ;;
    secret) gcloud secrets "$verb" "$resource" "$@" ;;
    repository) gcloud artifacts repositories "$verb" "$resource" --location="$REGION" "$@" ;;
  esac
}
# The condition of a role's binding to a member ("-" for none), or nothing
# when there is no such binding.
binding_condition() {
  local kind=$1 resource=$2 role=$3 member=$4
  iam get-iam-policy "$kind" "$resource" --flatten='bindings[].members' \
    --filter="bindings.role=$role AND bindings.members=$member" \
    --format='value(bindings.condition.expression.yesno(no="-"))' 2>/dev/null | head -n 1
}
add_binding() {
  local kind=$1 resource=$2 role=$3 member=$4 condition=$5 title=$6 flags=()
  if [ "$condition" != - ]; then
    flags=(--condition="expression=$condition,title=$title")
  elif [ "$kind" = project ]; then
    flags=(--condition=None)
  fi
  iam add-iam-policy-binding "$kind" "$resource" --role="$role" --member="$member" "${flags[@]}" --quiet >/dev/null 2>&1
}
# binding <kind> <resource> <role> <member> [condition title]
binding() {
  local kind=$1 resource=$2 role=$3 member=$4 condition=${5:--} title=${6:-} have
  local what="$role for $member on $kind $resource"
  [ "$condition" = - ] || what="$what, if $condition"
  have=$(binding_condition "$kind" "$resource" "$role" "$member")
  if [ "$have" = "$condition" ]; then
    in_place "$what"
  elif [ -n "$have" ]; then
    differs "$what: bound with the condition '$have' instead (not changed by this script)"
  elif [ "$mode" = check ]; then
    missing "$what"
  elif retry add_binding "$kind" "$resource" "$role" "$member" "$condition" "$title"; then
    made "$what"
  else
    echo "$name: could not grant $what" >&2
    exit 1
  fi
}
binding project "$PROJECT" "$DATABASES_ROLE_NAME" "serviceAccount:$DEPLOYER_EMAIL" "$INSTANCE_CONDITION" "only $INSTANCE"
binding project "$PROJECT" "$SERVICES_ROLE_NAME" "serviceAccount:$DEPLOYER_EMAIL"
binding repository "$IMAGE_REPOSITORY" roles/artifactregistry.repoAdmin "serviceAccount:$DEPLOYER_EMAIL"
binding service-account "$RUNTIME_EMAIL" roles/iam.serviceAccountUser "serviceAccount:$DEPLOYER_EMAIL"
binding service-account "$DEPLOYER_EMAIL" roles/iam.workloadIdentityUser "$PRINCIPAL_SET"
# The owner who runs this may act as the deployer, so api:hosting-check can
# ask what the deployer may do, and a deployment can be tried by hand as it.
# An owner could grant this to themselves anyway; it adds nothing they lack.
case "$account" in
  *.gserviceaccount.com) owner_member="serviceAccount:$account" ;;
  *@*) owner_member="user:$account" ;;
  *) owner_member="" ;;
esac
if [ -n "$owner_member" ]; then
  binding service-account "$DEPLOYER_EMAIL" roles/iam.serviceAccountTokenCreator "$owner_member"
fi
binding project "$PROJECT" roles/cloudsql.client "serviceAccount:$RUNTIME_EMAIL" "$INSTANCE_CONDITION" "only $INSTANCE"
binding secret "$PASSWORD_SECRET" roles/secretmanager.secretAccessor "serviceAccount:$RUNTIME_EMAIL"

# Nothing more on the project than the above: a role granted by hand is
# reported, never removed.
project_roles() {
  gcloud projects get-iam-policy "$PROJECT" --flatten='bindings[].members' \
    --filter="bindings.members=serviceAccount:$1" --format='value(bindings.role)' 2>/dev/null | sort | paste -sd' ' -
}
for pair in "$DEPLOYER_EMAIL=$(printf '%s\n' "$DATABASES_ROLE_NAME" "$SERVICES_ROLE_NAME" | sort | paste -sd' ' -)" "$RUNTIME_EMAIL=roles/cloudsql.client"; do
  account_email=${pair%%=*}
  roles=$(project_roles "$account_email")
  if [ "$roles" = "${pair#*=}" ]; then
    in_place "$account_email holds no other role on the project"
  elif [ -n "$roles" ] || [ "$mode" = setup ]; then
    differs "$account_email holds '$roles' on the project, expected only '${pair#*=}'"
  fi
done

# ---- As the deployer ------------------------------------------------------------
# Asks Google Cloud what the deployer may do (testIamPermissions, which changes
# nothing), and tries to read the password as the deployer. Needs the
# logged-in account to be able to impersonate it.
if [ "$mode" = check ]; then
  section "As the deployer ($DEPLOYER_EMAIL)"
  # granted <url> <permission...>: the ones of these the deployer holds there.
  granted() {
    local url=$1
    shift
    printf '{"permissions": [%s]}' "$(printf '"%s",' "$@" | sed 's/,$//')" |
      api_call POST "$url:testIamPermissions" "$DEPLOYER_EMAIL" |
      tr -d ' \n' | sed -n 's/.*"permissions":\[\([^]]*\)\].*/\1/p' | tr -d '"' | tr ',' '\n' | sed '/^$/d' | sort
  }
  project_url="https://cloudresourcemanager.googleapis.com/v1/projects/$PROJECT"
  repository_url="https://artifactregistry.googleapis.com/v1/projects/$PROJECT/locations/$REGION/repositories/$IMAGE_REPOSITORY"
  runtime_url="https://iam.googleapis.com/v1/projects/$PROJECT/serviceAccounts/$RUNTIME_EMAIL"
  secret_url="https://secretmanager.googleapis.com/v1/projects/$PROJECT/secrets/$PASSWORD_SECRET"

  if ! quietly gcloud auth print-access-token --impersonate-service-account="$DEPLOYER_EMAIL"; then
    missing "a token for the deployer: $account can't impersonate it (roles/iam.serviceAccountTokenCreator on it)"
  else
    # The databases role holds only on the instance, which has no
    # testIamPermissions of its own: the trial deployment proves it.
    # shellcheck disable=SC2086
    have=$(granted "$project_url" $SERVICES_PERMISSIONS)
    if [ "$have" = "$(sort <<<"$SERVICES_PERMISSIONS")" ]; then
      in_place "it may: $(paste -sd' ' <<<"$have") (project)"
    else
      missing "on the project, it holds only: $(paste -sd' ' <<<"$have")"
    fi
    # shellcheck disable=SC2086
    have=$(granted "$project_url" $DATABASES_PERMISSIONS)
    if [ -z "$have" ]; then
      in_place "it may not: $(paste -sd' ' <<<"$DATABASES_PERMISSIONS") on the project as a whole (only on $INSTANCE)"
    else
      differs "on the project as a whole, it may: $(paste -sd' ' <<<"$have")"
    fi
    need="artifactregistry.repositories.uploadArtifacts
artifactregistry.repositories.downloadArtifacts
artifactregistry.repositories.deleteArtifacts"
    # shellcheck disable=SC2086
    have=$(granted "$repository_url" $need)
    if [ "$have" = "$(sort <<<"$need")" ]; then
      in_place "it may push, pull and delete images in $IMAGE_REPOSITORY"
    else
      missing "in $IMAGE_REPOSITORY, it holds only: $(paste -sd' ' <<<"$have")"
    fi
    have=$(granted "$runtime_url" iam.serviceAccounts.actAs)
    if [ "$have" = iam.serviceAccounts.actAs ]; then
      in_place "it may run services as $RUNTIME_EMAIL"
    else
      missing "it can't run services as $RUNTIME_EMAIL"
    fi

    # shellcheck disable=SC2086
    have=$(granted "$project_url" $DEPLOYER_MUST_NOT)
    if [ -z "$have" ]; then
      in_place "it may not: $(paste -sd' ' <<<"$DEPLOYER_MUST_NOT") (project)"
    else
      differs "on the project, it may: $(paste -sd' ' <<<"$have")"
    fi
    for resource in "$repository_url=artifactregistry.repositories.delete" "$secret_url=secretmanager.versions.access" "$runtime_url=iam.serviceAccountKeys.create"; do
      have=$(granted "${resource%%=*}" "${resource#*=}")
      if [ -z "$have" ]; then
        in_place "it may not: ${resource#*=} (on ${resource%%=*##*/})"
      else
        differs "it may: $have (on ${resource%%=*})"
      fi
    done
    # And for real: reading the password as the deployer must be refused.
    if gcloud secrets versions access latest --secret="$PASSWORD_SECRET" \
      --impersonate-service-account="$DEPLOYER_EMAIL" >/dev/null 2>&1; then
      differs "it could read the password in $PASSWORD_SECRET"
    else
      in_place "reading $PASSWORD_SECRET as the deployer is refused"
    fi
  fi
fi

# ---- Summary ----------------------------------------------------------------
echo
if [ "$problems" -gt 0 ]; then
  echo "$name: $problems problem(s), listed above." >&2
  exit 1
fi
if [ "$mode" = check ]; then
  echo "$name: everything is in place."
elif [ "$changes" -eq 0 ]; then
  echo "$name: nothing to change; everything was already in place."
else
  echo "$name: made $changes change(s), listed above."
fi
cat <<EOF

For CI (none of these is a secret):
  project ID                $PROJECT
  project number            $number
  region                    $REGION
  workload identity provider $PROVIDER_NAME
  deployer                  $DEPLOYER_EMAIL
  runtime                   $RUNTIME_EMAIL
  image repository          $REGION-docker.pkg.dev/$PROJECT/$IMAGE_REPOSITORY
  instance connection name  $CONNECTION_NAME
  database user             $DATABASE_USER
  password secret           $PASSWORD_SECRET
  preview service names     $SERVICE_PREFIX<number>
EOF

