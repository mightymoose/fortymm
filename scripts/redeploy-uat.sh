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
API_IMAGE="fortymm/api:uat"
WEB_IMAGE="fortymm/web:uat"
APNS_KEY="secrets/AuthKey_68VYRLMWWR.p8"
UAT_URL="${UAT_URL:-https://uat.fortymm.com}"

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
docker build -t "$WEB_IMAGE" -f web-client/Dockerfile.uat web-client

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
  --wait --timeout 5m

# The migrate Job is a post-* Helm hook; --wait above already blocks on it.
echo
echo "==> Waiting for the api rollout"
kubectl rollout status deploy/api -n "$NAMESPACE" --timeout=120s

echo
echo "==> Waiting for api to report healthy at $UAT_URL"
deadline=$(( $(date +%s) + 90 ))
until curl -fsS --max-time 3 "$UAT_URL/api/v1/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: $UAT_URL/api/v1/health did not respond within 90s" >&2
    echo "--- recent api logs ---" >&2
    kubectl logs -n "$NAMESPACE" deploy/api --tail=40 >&2 || true
    exit 1
  fi
  sleep 2
done

echo
echo "==> Pod status"
kubectl get pods -n "$NAMESPACE"

echo
echo "==> Health"
curl -fsS "$UAT_URL/api/v1/health"
echo
echo "Redeployed: $UAT_URL"
