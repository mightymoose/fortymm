#!/usr/bin/env bash
# Rebuild and (re)deploy the fortymm-uat stack on a local k3d Kubernetes
# cluster via Helm, then smoke-check https://uat.fortymm.com. Run from
# anywhere — the script cd's to the repo root.
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
# Requirements: docker, kubectl, helm, k3d (brew install helm k3d).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CLUSTER="fortymm-uat"
NAMESPACE="fortymm-uat"
RELEASE="fortymm-uat"
CHART="deploy/uat"
HOST_PORT=8084
NODE_PORT=30084
API_REPO="fortymm/api"
WEB_REPO="fortymm/web"
APNS_KEY="secrets/AuthKey_68VYRLMWWR.p8"
UAT_URL="${UAT_URL:-https://uat.fortymm.com}"

# Observability stack (kube-prometheus-stack + loki-stack + tempo) in its own
# namespace/release. Set DEPLOY_OBSERVABILITY=false to skip it.
OBS_NAMESPACE="monitoring"
OBS_RELEASE="observability"
OBS_CHART="deploy/observability"
DEPLOY_OBSERVABILITY="${DEPLOY_OBSERVABILITY:-true}"

# Read a single value from .env, stripping one layer of surrounding quotes.
read_env() { grep "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }

for bin in docker kubectl helm k3d; do
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

# Tag every build with a unique id (post-merge commit + build epoch) instead of
# a static `:uat`. The tag is the image string in the pod template, so a unique
# tag makes `helm upgrade` see a changed template and roll both deployments
# atomically (honoring the zero-downtime RollingUpdate). With the old mutable
# `:uat` tag the template never changed, so a redeploy re-imported new content
# under the same tag but never rolled — and when only one web replica later
# restarted on its own it drifted onto the new build while its sibling stayed on
# the old one. The two content-hashed SPA bundles then sat behind the
# round-robin routing nginx, so ~half of loads fetched index.html from one pod
# but got its `assets/index-*.js` chunk routed to the other → 404 → blank page.
# The epoch suffix forces a fresh roll even on a same-commit rebuild. (Old
# unique tags accumulate in the k3d image store; prune with `k3d image` /
# `docker image prune` if it grows.)
IMAGE_TAG="$(git rev-parse --short HEAD)-$(date +%s)"
API_IMAGE="${API_REPO}:${IMAGE_TAG}"
WEB_IMAGE="${WEB_REPO}:${IMAGE_TAG}"

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
echo
echo "==> Building images"
docker build -t "$API_IMAGE" -f api/Dockerfile.dev api
# Enable Grafana Faro in the UAT bundle: telemetry posts same-origin to
# /faro/collect, which the routing nginx forwards to Alloy in `monitoring`.
WEB_BUILD_ARGS=()
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  WEB_BUILD_ARGS+=(--build-arg "VITE_FARO_COLLECTOR_URL=/faro/collect")
fi
# Bake the browser Google Maps key into the UAT bundle when the operator has set
# it in .env. OPTIONAL: unset/blank => no build arg, the bundle ships without a
# Maps key and the map component falls back to a text render (keyless build stays
# valid). This is the *browser* key; the server-side GOOGLE_GEOCODING_API_KEY is
# synced into the fortymm-uat-env Secret below, not passed as a build arg.
# `|| true`: read_env greps .env under `set -e -o pipefail`, so an absent
# (optional) line would otherwise abort the deploy — swallow that miss.
VITE_GOOGLE_MAPS_API_KEY="$(read_env VITE_GOOGLE_MAPS_API_KEY || true)"
if [ -n "$VITE_GOOGLE_MAPS_API_KEY" ]; then
  WEB_BUILD_ARGS+=(--build-arg "VITE_GOOGLE_MAPS_API_KEY=$VITE_GOOGLE_MAPS_API_KEY")
fi
docker build -t "$WEB_IMAGE" "${WEB_BUILD_ARGS[@]+"${WEB_BUILD_ARGS[@]}"}" -f web-client/Dockerfile.uat web-client

echo
echo "==> Importing images into k3d"
k3d image import "$API_IMAGE" "$WEB_IMAGE" -c "$CLUSTER"

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
helm upgrade --install "$RELEASE" "$CHART" \
  --namespace "$NAMESPACE" \
  --set images.api.tag="$IMAGE_TAG" \
  --set images.web.tag="$IMAGE_TAG" \
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
