#!/usr/bin/env bash
# (Re)deploy the fortymm-uat stack on a local k3d Kubernetes cluster via Helm,
# then smoke-check https://uat.fortymm.com. Run from anywhere — the script cd's
# to the repo root.
#
# This script BUILDS NOTHING. The api and web-client images come from GHCR,
# published per commit on `main` by .github/workflows/publish-images.yml, and
# are deployed pinned by manifest digest. A merge is therefore not deployable
# until that workflow finishes (~20-30 min, dominated by the emulated arm64
# leg). See docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md.
#
# Run from `main` or the legacy `uat-deploy` worktree. The UAT-only config
# (this script, deploy/uat/ Helm chart, Dockerfiles) lives on main, so
# deploying straight from a main checkout works. Each run fetches origin/main
# and merges it into the current branch, so deploys reflect the latest main.
#
# Topology: host Caddy terminates TLS for uat.fortymm.com and reverse-proxies
# to 127.0.0.1:8084. k3d maps host 8084 -> the routing nginx NodePort (30084),
# which fans out to the api / web-client Services. So no Caddyfile change is
# needed when moving from docker-compose to k8s.
#
# Requirements: docker, curl, kubectl, helm, k3d (brew install helm k3d).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLUSTER="fortymm-uat"
NAMESPACE="fortymm-uat"
RELEASE="fortymm-uat"
CHART="deploy/uat"
HOST_PORT=8084
NODE_PORT=30084
APNS_KEY="secrets/AuthKey_68VYRLMWWR.p8"
UAT_URL="${UAT_URL:-https://uat.fortymm.com}"

# The two GHCR packages publish-images.yml pushes. These three files must name
# the same packages: the workflow's API_IMAGE/WEB_IMAGE env, deploy/uat/values.yaml's
# images.{api,web}.repository, and here. (A mismatch is loud, not silent: the
# digest resolved from one package does not exist in another, so the pull fails.)
GHCR_OWNER="mightymoose"
API_PACKAGE="fortymm-api"
WEB_PACKAGE="fortymm-web-client"
PUBLISH_RUNS_URL="https://github.com/${GHCR_OWNER}/fortymm/actions/workflows/publish-images.yml"

# How long to wait for the deploying commit's images to appear in GHCR before
# giving up. The publish is multi-arch and its arm64 leg is QEMU-emulated on an
# amd64 runner, so ~20-30 min is normal and the jobs themselves allow 90; 40
# minutes covers a normal run plus queue time without hanging a terminal all
# day. Deploying straight after a merge is the case this exists for. Override
# with DIGEST_WAIT_TIMEOUT_S=0 to fail immediately instead of waiting.
DIGEST_WAIT_TIMEOUT_S="${DIGEST_WAIT_TIMEOUT_S:-2400}"
DIGEST_POLL_INTERVAL_S="${DIGEST_POLL_INTERVAL_S:-30}"

# Observability stack (kube-prometheus-stack + loki-stack + tempo) in its own
# namespace/release. Set DEPLOY_OBSERVABILITY=false to skip it.
OBS_NAMESPACE="monitoring"
OBS_RELEASE="observability"
OBS_CHART="deploy/observability"
DEPLOY_OBSERVABILITY="${DEPLOY_OBSERVABILITY:-true}"

# Read a single value from .env, stripping one layer of surrounding quotes.
read_env() { grep "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }

for bin in docker curl kubectl helm k3d; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH." >&2; exit 1; }
done

branch=$(git rev-parse --abbrev-ref HEAD)
case "$branch" in
  main | uat-deploy) ;;
  *)
    echo "ERROR: refusing to deploy from branch '$branch'; expected 'main' or 'uat-deploy'." >&2
    echo "Check out main (or the uat-deploy worktree) before deploying." >&2
    exit 1
    ;;
esac

echo "==> Fetching origin/main and merging into $branch"
git fetch origin main
before=$(git rev-parse HEAD)
git merge --no-edit origin/main
after=$(git rev-parse HEAD)
if [ "$before" = "$after" ]; then
  echo "($branch already includes latest origin/main)"
else
  echo "(advanced $branch: $before -> $after)"
fi

# The tag CI published this commit's images under: a FIXED 12-character
# truncation of the full SHA, computed AFTER the merge above so it names what is
# actually about to be deployed.
#
# Deliberately NOT `git rev-parse --short`. That picks its length from the
# repository's object count (`core.abbrev=auto`) and from any `core.abbrev` the
# operator has set — 8 characters in this clone today, 9 once it grows, 7 in a
# shallow clone. publish-images.yml tags with `${GITHUB_SHA::12}`, and the two
# MUST agree exactly: a length that drifts turns a commit that published
# perfectly well into a tag-not-found. Keep this line and that one in lockstep.
#
# There is no epoch suffix any more, and reintroducing one would be a mistake.
# It existed because a LOCAL rebuild could produce different content under one
# commit, so the pod template had to change to force a roll. Published images
# are immutable and pinned below by digest, so a same-commit redeploy is a
# correct no-op — byte-identical content has nothing to roll to.
IMAGE_TAG="$(git rev-parse HEAD | cut -c1-12)"

# --- cluster ----------------------------------------------------------------
echo
if k3d cluster list -o json 2>/dev/null | grep -q "\"name\":\"$CLUSTER\""; then
  echo "==> k3d cluster '$CLUSTER' exists"
  # `cluster start` is a no-op if already running.
  k3d cluster start "$CLUSTER" >/dev/null 2>&1 || true
else
  echo "==> Creating k3d cluster '$CLUSTER' (host $HOST_PORT -> nodePort $NODE_PORT)"
  # Disable the bundled Traefik — we route through our own nginx Service. The
  # loadbalancer port map publishes host 8084 to the nginx NodePort so Caddy
  # (already pointing at 127.0.0.1:8084) needs no change.
  k3d cluster create "$CLUSTER" \
    --port "${HOST_PORT}:${NODE_PORT}@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0"
fi

# Point kubectl/helm at this cluster for the rest of the run.
export KUBECONFIG
KUBECONFIG="$(k3d kubeconfig write "$CLUSTER")"

kubectl get namespace "$NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$NAMESPACE"

# --- images -----------------------------------------------------------------
# Nothing is built here. Each package's `:<12-char sha>` tag is resolved to the
# digest of its MANIFEST LIST (the multi-arch index, not one platform's
# manifest) through the registry v2 API, anonymously — the packages are public,
# which is also why the chart carries no imagePullSecrets. The pods then name
# `repository@sha256:…`, so "every replica runs the same bytes" is structural
# rather than conventional; see the "UAT redeploy lands stale code" incident in
# deploy/CLAUDE.md for what it costs when it isn't.
#
# That one anonymous read doubles as the public-visibility preflight, at no
# extra request: GHCR publishes a package PRIVATE on its first push even from a
# public repo, and an anonymous read of a private package is refused — so if the
# resolve succeeds, the cluster can pull. Failing here with the click-path beats
# an ErrImagePull discovered five minutes into `helm --wait`.

# Mint an anonymous pull token for one package. GHCR wants a bearer token even
# for public packages. A package that is private — or that no successful publish
# has created yet — gets no token at all: the endpoint answers with an
# {"errors":[{"code":"DENIED",…}]} body carrying no `token` field. That absence
# is the visibility signal.
#
# Returns: 0 + token on stdout, 2 if ghcr.io was unreachable (curl already said
# why on stderr, and that is NOT a visibility problem), 1 if access was denied.
ghcr_pull_token() {
  local pkg="$1" body token
  body="$(curl -sS --max-time 20 \
    "https://ghcr.io/token?scope=repository:${GHCR_OWNER}/${pkg}:pull")" || return 2
  token="$(printf '%s' "$body" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
  [ -n "$token" ] || return 1
  printf '%s' "$token"
}

# The one-time-per-package manual step, printed wherever the registry says no.
ghcr_visibility_help() {
  local pkg="$1"
  echo "ERROR: anonymous pull DENIED for ghcr.io/${GHCR_OWNER}/${pkg}." >&2
  echo "       Either no publish has ever created this package, or it is not public." >&2
  echo "       Normally it IS public without anyone doing anything: a package pushed by a" >&2
  echo "       workflow using GITHUB_TOKEN is linked to the publishing repo and inherits" >&2
  echo "       its visibility, and this repo is public. So seeing this means something" >&2
  echo "       changed -- the package's visibility was edited by hand, or the repository" >&2
  echo "       itself went private. Check, and set it back if needed:" >&2
  echo "         github.com/${GHCR_OWNER}/fortymm -> Packages -> ${pkg} ->" >&2
  echo "         Package settings -> Change visibility -> Public" >&2
  echo "       (CI cannot do this for you: GITHUB_TOKEN can push to a package but cannot" >&2
  echo "       change its visibility.) Runs: $PUBLISH_RUNS_URL" >&2
}

# HEAD one manifest and print its Docker-Content-Digest. HEAD is enough — the
# digest is a response header — and skips pulling a body we would discard.
#
# The Accept header is load-bearing, and its failure mode is nastier than it
# looks. It names the OCI image index and the Docker manifest-list media types,
# so the registry answers for the multi-arch INDEX and returns the index's
# digest. GHCR does not content-negotiate down to a platform manifest when those
# types are missing — measured against a public multi-arch package, dropping
# this header (or sending only the single-manifest type) returns a flat **404**.
# That would read here as "not published yet" and send the operator into a
# 40-minute wait for an image that has existed all along. Do not trim it.
#
# Returns: 0 + digest on stdout, 2 if the tag is not there (404), 3 if the
# registry refused the read (401/403), 1 otherwise. The 401/403 case is
# defensive: GHCR refuses a package we may not read at the TOKEN endpoint above,
# and answers this endpoint 404 — not 403 — when the token is valid but scoped
# to another package, so in practice a refusal never reaches here. It is kept so
# an unauthenticated or differently-behaved registry read reports "denied"
# rather than being mistaken for "not published yet" and waited on.
ghcr_manifest_digest() {
  local pkg="$1" tag="$2" token="$3" headers status digest
  headers="$(mktemp)"
  status="$(curl -sS --max-time 20 --head -o /dev/null -D "$headers" -w '%{http_code}' \
    -H "Authorization: Bearer ${token}" \
    -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json" \
    "https://ghcr.io/v2/${GHCR_OWNER}/${pkg}/manifests/${tag}")" || { rm -f "$headers"; return 1; }
  # Header names are case-insensitive and the line ends in CRLF; awk (not grep)
  # so a no-match can't abort the pipeline under `set -o pipefail`.
  digest="$(tr -d '\r' <"$headers" | awk 'tolower($1) == "docker-content-digest:" { print $2 }' | tail -1)"
  rm -f "$headers"
  case "$status" in
    200)
      # A 200 with no digest header would leave $digest empty, and an empty
      # digest is the one bad value the chart tolerates (it falls back to the
      # tag). Refuse to print it.
      [ -n "$digest" ] || { echo "ERROR: ${pkg}:${tag} returned 200 with no Docker-Content-Digest header." >&2; return 1; }
      printf '%s' "$digest"
      ;;
    404) return 2 ;;
    401 | 403) return 3 ;;
    *) echo "ERROR: unexpected HTTP $status resolving ghcr.io/${GHCR_OWNER}/${pkg}:${tag}." >&2; return 1 ;;
  esac
}

# Resolve one package's tag to its manifest-list digest, waiting out a publish
# that is still running. Prints ONLY the digest on stdout — every progress and
# error line goes to stderr, because callers capture this in `$(…)`.
resolve_published_digest() {
  local pkg="$1" tag="$2" token digest rc started deadline now attempt=0
  started="$(date +%s)"
  deadline=$(( started + DIGEST_WAIT_TIMEOUT_S ))
  while :; do
    # Re-minted every attempt on purpose: these tokens are short-lived, and a
    # wait measured in tens of minutes would otherwise start 401ing halfway
    # through and read as a registry error.
    rc=0
    token="$(ghcr_pull_token "$pkg")" || rc=$?
    case "$rc" in
      0) ;;
      2) echo "ERROR: could not reach ghcr.io for a pull token (see curl's message above)." >&2
         return 1 ;;
      *) ghcr_visibility_help "$pkg"; return 1 ;;
    esac

    rc=0
    digest="$(ghcr_manifest_digest "$pkg" "$tag" "$token")" || rc=$?
    case "$rc" in
      0) printf '%s' "$digest"; return 0 ;;
      2) ;;  # tag not there yet — fall through to the wait below
      3) ghcr_visibility_help "$pkg"; return 1 ;;
      *) return 1 ;;  # already explained itself; not worth retrying
    esac

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "ERROR: no image published for ghcr.io/${GHCR_OWNER}/${pkg}:${tag} after ${DIGEST_WAIT_TIMEOUT_S}s." >&2
      echo "       Commit $(git rev-parse HEAD) has no images. Either publish-images is still" >&2
      echo "       running or it failed for this commit, or HEAD is not a commit that exists on" >&2
      echo "       origin/main (only pushed main commits are ever published)." >&2
      echo "       Check $PUBLISH_RUNS_URL, then re-run this script." >&2
      echo "       NOT deploying an older commit instead: silently running something other than" >&2
      echo "       the commit you asked for is the failure mode this whole path exists to remove." >&2
      return 1
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -eq 1 ]; then
      echo "    ghcr.io/${GHCR_OWNER}/${pkg}:${tag} not published yet — waiting up to ${DIGEST_WAIT_TIMEOUT_S}s." >&2
      echo "    (multi-arch publish takes ~20-30 min: $PUBLISH_RUNS_URL)" >&2
    elif [ $((attempt % 4)) -eq 0 ]; then
      echo "    still waiting for ${pkg}:${tag} ($(( now - started ))s elapsed of ${DIGEST_WAIT_TIMEOUT_S}s)" >&2
    fi
    sleep "$DIGEST_POLL_INTERVAL_S"
  done
}

# Belt and braces on top of the chart's own validation. The chart FAILS the
# render on a malformed digest, but an EMPTY one is not malformed there — it is
# the documented "render without a deploy" fallback, so it would quietly deploy
# the moving `:main` tag instead of this commit. Check the shape here, where an
# unset digest is unambiguously a bug in this script.
assert_digest() {
  local what="$1" value="$2"
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || {
    echo "ERROR: resolved $what digest is not a sha256 manifest digest: '${value}'" >&2
    exit 1
  }
}

echo
echo "==> Resolving published image digests for $IMAGE_TAG"
API_DIGEST="$(resolve_published_digest "$API_PACKAGE" "$IMAGE_TAG")" || exit 1
assert_digest "$API_PACKAGE" "$API_DIGEST"
echo "    ${API_PACKAGE}: $API_DIGEST"
WEB_DIGEST="$(resolve_published_digest "$WEB_PACKAGE" "$IMAGE_TAG")" || exit 1
assert_digest "$WEB_PACKAGE" "$WEB_DIGEST"
echo "    ${WEB_PACKAGE}: $WEB_DIGEST"

# --- secrets ----------------------------------------------------------------
# Created from the gitignored source-of-truth files, never committed and never
# baked into the chart. Re-runnable via apply.
echo
echo "==> Syncing secrets from .env and $APNS_KEY"
[ -f .env ] || { echo "ERROR: .env not found (copy .env.example and fill in)." >&2; exit 1; }
[ -f "$APNS_KEY" ] || { echo "ERROR: $APNS_KEY not found." >&2; exit 1; }

# The tailscale proxy reads TS_AUTHKEY from the .env-backed secret. When it's
# enabled in the chart, fail fast with a clear message rather than a CrashLooping
# pod. Read tailscale.enabled straight from the chart values (same source of
# truth the deploy uses) so this check honors the flag it advertises.
ts_enabled=$(helm show values "$CHART" | awk '/^tailscale:/{f=1;next} f&&/^[^[:space:]]/{f=0} f&&/^[[:space:]]+enabled:/{print $2;exit}')
if [ "$ts_enabled" = "true" ]; then
  grep -qE '^TS_AUTHKEY=.' .env || {
    echo "ERROR: TS_AUTHKEY missing/empty in .env (tailscale.enabled=true)." >&2
    echo "       Add a reusable auth key (Tailscale admin -> Settings -> Keys), or" >&2
    echo "       set tailscale.enabled=false in deploy/uat/values.yaml to skip it." >&2
    exit 1
  }
fi

# The observability stack needs a Grafana admin password and (for its tailscale
# proxies) the same TS_AUTHKEY. Fail fast here rather than mid-deploy.
require_env() {
  grep -qE "^$1=." .env || {
    echo "ERROR: $1 missing/empty in .env ($2)." >&2
    echo "       Add it to .env, or set DEPLOY_OBSERVABILITY=false." >&2
    exit 1
  }
}
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  require_env GRAFANA_ADMIN_PASSWORD "Grafana admin password"
  require_env TS_AUTHKEY "observability tailscale proxies"
fi

kubectl create secret generic fortymm-uat-env \
  --namespace "$NAMESPACE" --from-env-file=.env \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl create secret generic fortymm-uat-apns \
  --namespace "$NAMESPACE" --from-file=apns_auth_key.p8="$APNS_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- deploy -----------------------------------------------------------------
echo
echo "==> helm upgrade --install $RELEASE"
# Pin by digest, not tag. Both replicas of each deployment then name the same
# content-addressed reference, so they cannot end up on different bytes even if
# one reschedules later or the `:main` tag moves under us. If this is the same
# commit that is already deployed the pod templates are unchanged and helm
# rolls nothing — correct, not a missed deploy.
helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" \
  --set images.api.digest="$API_DIGEST" \
  --set images.web.digest="$WEB_DIGEST" \
  --wait --timeout 5m

# The migrate Job is a post-* Helm hook; --wait above already blocks on it.
echo
echo "==> Waiting for the api and web-client rollouts"
kubectl rollout status deploy/api -n "$NAMESPACE" --timeout=120s
kubectl rollout status deploy/web-client -n "$NAMESPACE" --timeout=120s

echo
echo "==> Waiting for api to report ready at $UAT_URL"
deadline=$(( $(date +%s) + 90 ))
until curl -fsS --max-time 3 "$UAT_URL/api/v1/readyz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: $UAT_URL/api/v1/readyz did not respond within 90s" >&2
    echo "--- recent api logs ---" >&2
    kubectl logs -n "$NAMESPACE" deploy/api --tail=40 >&2 || true
    exit 1
  fi
  sleep 2
done

# --- observability ----------------------------------------------------------
# Separate release in the `monitoring` namespace: kube-prometheus-stack (Grafana
# + Prometheus + Alertmanager), loki-stack (Loki + Promtail with email
# redaction), Tempo. Each of Grafana/Prometheus/Loki gets a tailscale serve
# proxy (private MagicDNS hostname). Chart deps are vendored at deploy time.
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  echo
  echo "==> Deploying observability stack ($OBS_RELEASE -> $OBS_NAMESPACE)"
  kubectl get namespace "$OBS_NAMESPACE" >/dev/null 2>&1 || kubectl create namespace "$OBS_NAMESPACE"

  # Secrets from .env (never committed): Grafana admin creds + tailscale key.
  kubectl create secret generic grafana-admin \
    --namespace "$OBS_NAMESPACE" \
    --from-literal=admin-user=admin \
    --from-literal=admin-password="$(read_env GRAFANA_ADMIN_PASSWORD)" \
    --dry-run=client -o yaml | kubectl apply -f -
  kubectl create secret generic tailscale-authkey \
    --namespace "$OBS_NAMESPACE" \
    --from-literal=TS_AUTHKEY="$(read_env TS_AUTHKEY)" \
    --dry-run=client -o yaml | kubectl apply -f -

  # Vendor chart dependencies (helm dependency build reads Chart.lock).
  helm repo add prometheus-community https://prometheus-community.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo add grafana https://grafana.github.io/helm-charts >/dev/null 2>&1 || true
  helm repo update prometheus-community grafana >/dev/null
  helm dependency build "$OBS_CHART"

  echo
  echo "==> helm upgrade --install $OBS_RELEASE"
  helm upgrade --install "$OBS_RELEASE" "$OBS_CHART" \
    --namespace "$OBS_NAMESPACE" \
    --wait --timeout 10m

  echo
  echo "==> Observability pods"
  kubectl get pods -n "$OBS_NAMESPACE"
else
  echo
  echo "(skipping observability deploy; DEPLOY_OBSERVABILITY=$DEPLOY_OBSERVABILITY)"
fi

echo
echo "==> Pod status"
kubectl get pods -n "$NAMESPACE"

echo
echo "==> Readiness"
curl -fsS "$UAT_URL/api/v1/readyz"
echo
echo "==> Health"
curl -fsS "$UAT_URL/api/v1/health"
echo
echo "Redeployed: $UAT_URL"
echo "  commit $(git rev-parse HEAD) (published as :$IMAGE_TAG)"
echo "  ${API_PACKAGE}@${API_DIGEST}"
echo "  ${WEB_PACKAGE}@${WEB_DIGEST}"
