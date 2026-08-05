#!/usr/bin/env bash
# (Re)deploy the fortymm-uat stack on a local k3d Kubernetes cluster via Helm,
# then smoke-check https://uat.fortymm.com. Run from anywhere — the script cd's
# to the repo root.
#
# This script BUILDS NOTHING AND PACKAGES NOTHING. Both the charts and the
# images come from GHCR, published per commit on `main` by
# .github/workflows/publish.yml. The chart is pulled at the version for the
# commit being deployed, resolved to its OCI digest, and deployed by that
# digest; the image digests ride INSIDE the published chart, so nothing here
# resolves them. A merge is therefore not deployable until that workflow
# finishes (~25 min, dominated by the emulated arm64 leg) — the chart job runs
# after the image jobs, so waiting for the chart implicitly waits for the
# images. See
# docs/adr/20260805-charts-publish-to-ghcr-versioned-by-commit-with-image-digests-baked-in.md
# and docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md.
#
# Deploying the PUBLISHED chart rather than the working tree is deliberate:
# UAT is the only thing that ever exercises the artifact CI publishes, so a
# path that rendered deploy/fortymm/ from disk would leave the first person to
# discover a broken package outside this repo. There is no such path here.
#
# The checkout is still needed for two things a published chart cannot carry:
# this script, and the environment values in deploy/environments/ (hostnames,
# Secret names, the tailnet node name). Run from `main` or the legacy
# `uat-deploy` worktree. Each run fetches origin/main and merges it into the
# current branch, so deploys reflect the latest main.
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
# The release names the environment, because the chart no longer does.
RELEASE="fortymm-uat"
HOST_PORT=8084
# The k3d loadbalancer maps HOST_PORT to this NodePort, so it must equal
# `nginxNodePort` in $STACK_VALUES (deploy/environments/uat.yaml). The chart
# itself names no port — it defaults the value empty and lets Kubernetes
# allocate — so nothing but these two lines keeps host :8084 pointed at the
# routing nginx. Change one and you must change the other.
NODE_PORT=30084
APNS_KEY="secrets/AuthKey_68VYRLMWWR.p8"
UAT_URL="${UAT_URL:-https://uat.fortymm.com}"

# Where publish.yml pushes both charts. `helm push` appends the chart name, so
# each chart lands at ${CHART_REPO}/<name from its Chart.yaml>. That workflow's
# CHART_REPO env and this line must name the same repository — a mismatch is
# loud, not silent: the pull below simply finds nothing.
GHCR_OWNER="mightymoose"
CHART_REPO="oci://ghcr.io/${GHCR_OWNER}/fortymm/charts"
STACK_CHART="fortymm"
PUBLISH_RUNS_URL="https://github.com/${GHCR_OWNER}/fortymm/actions/workflows/publish.yml"

# UAT's half of the deploy. The charts are environment-neutral: hostnames,
# Secret names, the tailnet node name and UAT's solver sizing all live here, and
# without these files a deploy would quietly render the charts' neutral defaults
# and mount Secrets that do not exist. See
# docs/adr/20260805-the-stack-chart-is-environment-neutral-and-named-fortymm.md.
STACK_VALUES="deploy/environments/uat.yaml"
OBS_VALUES="deploy/environments/uat-observability.yaml"

# How long to wait for the deploying commit's STACK chart to appear in GHCR
# before giving up. Its job runs after the two image jobs, whose arm64 leg is
# QEMU-emulated on an amd64 runner, so ~25 min is normal and the jobs themselves
# allow 90; 40 minutes covers a normal run plus queue time without hanging a
# terminal all day. Deploying straight after a merge is the case this exists
# for. Override with DIGEST_WAIT_TIMEOUT_S=0 to fail immediately instead of
# waiting. (The variable keeps its name from when this waited on the two image
# digests: it still waits for a digest, now the chart's.)
DIGEST_WAIT_TIMEOUT_S="${DIGEST_WAIT_TIMEOUT_S:-2400}"
# The observability chart gets its own, much shorter budget. It `needs: [tag]`
# only, so it publishes minutes into a run rather than behind the images: by the
# time the stack chart resolves, this one has existed for twenty-odd minutes.
# Waiting 40 more minutes for it could only ever mean its job FAILED, which time
# does not fix. One minute absorbs a registry blip and nothing else.
OBS_DIGEST_WAIT_TIMEOUT_S="${OBS_DIGEST_WAIT_TIMEOUT_S:-60}"
DIGEST_POLL_INTERVAL_S="${DIGEST_POLL_INTERVAL_S:-30}"

# Observability stack (kube-prometheus-stack + loki-stack + tempo) in its own
# namespace/release. Set DEPLOY_OBSERVABILITY=false to skip it.
OBS_NAMESPACE="monitoring"
OBS_RELEASE="observability"
OBS_CHART="observability"
DEPLOY_OBSERVABILITY="${DEPLOY_OBSERVABILITY:-true}"

# Pulled chart packages land here — one tarball per chart, thrown away on exit.
# The pull is what resolves a version to a digest, and `helm pull` insists on
# writing the package somewhere; nothing reads the tarballs. The deploy installs
# from the registry by digest, not from these files.
CHART_DIR="$(mktemp -d)"
trap 'rm -rf "$CHART_DIR"' EXIT

# Read a single value from .env, stripping one layer of surrounding quotes.
read_env() { grep "^$1=" .env | head -1 | cut -d= -f2- | sed -e "s/^[\"']//" -e "s/[\"']\$//"; }

for bin in docker curl kubectl helm k3d; do
  command -v "$bin" >/dev/null 2>&1 || { echo "ERROR: '$bin' not found on PATH." >&2; exit 1; }
done

# Checked here rather than where helm reads them, which is on the far side of a
# wait that can last 40 minutes. Without these files the charts would render
# their neutral defaults: no UAT hostnames, and Secret names that do not exist
# in this cluster. Only the files this run will actually read are required — a
# DEPLOY_OBSERVABILITY=false run never opens $OBS_VALUES, so a missing one is
# not its problem.
required_values=("$STACK_VALUES")
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  required_values+=("$OBS_VALUES")
fi
for f in "${required_values[@]}"; do
  [ -f "$f" ] || { echo "ERROR: environment values file '$f' not found." >&2; exit 1; }
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

# The version CI published this commit's charts under, computed AFTER the merge
# above so it names what is actually about to be deployed. Two parts, both
# load-bearing:
#
#   - a FIXED 12-character truncation of the full SHA, deliberately NOT
#     `git rev-parse --short`. That picks its length from the repository's
#     object count (`core.abbrev=auto`) and from any `core.abbrev` the operator
#     has set — 8 characters in this clone today, 9 once it grows, 7 in a
#     shallow clone. publish.yml derives its version from `${GITHUB_SHA::12}`,
#     and the two MUST agree exactly: a length that drifts turns a commit that
#     published perfectly well into a version-not-found. Keep this line and that
#     one in lockstep.
#   - the `sha` prefix. Helm validates a chart version as SemVer, and SemVer
#     forbids a leading zero in a NUMERIC pre-release identifier, so the tidier
#     `0.1.0-<sha>` is rejected whenever the truncation is all digits starting
#     with 0. Gluing `sha` on makes the identifier alphanumeric, and therefore
#     always legal. Do not tidy it away.
#
# There is no epoch suffix any more, and reintroducing one would be a mistake.
# It existed because a LOCAL rebuild could produce different content under one
# commit, so the pod template had to change to force a roll. Published charts
# and images are immutable and deployed below by digest, so a same-commit
# redeploy is a correct no-op — byte-identical content has nothing to roll to.
COMMIT_SHA12="$(git rev-parse HEAD | cut -c1-12)"
CHART_VERSION="0.1.0-sha${COMMIT_SHA12}"

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

# --- chart ------------------------------------------------------------------
# Nothing is built or packaged here. The chart for this commit is pulled from
# GHCR anonymously (the packages are public, which is also why no chart carries
# imagePullSecrets) and resolved to its OCI digest, so the operator names ONE
# coordinate — the commit — and the cluster gets content-addressed bytes.
#
# The image digests are NOT resolved here any more: CI bakes them into the
# chart's values at package time, so chart and images cannot drift apart. That
# is what makes the chart version a complete description of one commit's stack.
#
# The pull doubles as the anonymous-pullability preflight, at no extra request.
# If it succeeds the cluster can pull the same artifact; if it never does, this
# fails with the click-path below rather than dying five minutes into
# `helm --wait`.

# The manual step to check whenever the registry keeps saying no. Printed as the
# SECONDARY cause on a timeout, never on its own: GHCR answers an anonymous
# token request for a package that is private and for one that no publish has
# created yet with the identical 403 `denied`, so "denied" cannot be read as
# "private" while a publish for this commit may simply still be running.
ghcr_visibility_help() {
  local pkg="$1"
  echo "       If the run for this commit DID succeed, the other cause is visibility:" >&2
  echo "       an anonymous pull of a private package is refused the same way a missing" >&2
  echo "       one is. Normally the package IS public without anyone doing anything -- a" >&2
  echo "       package pushed by a workflow using GITHUB_TOKEN is linked to the publishing" >&2
  echo "       repo and inherits its visibility, and this repo is public. So check that" >&2
  echo "       nothing changed it by hand, and set it back if needed:" >&2
  echo "         github.com/${GHCR_OWNER}/fortymm -> Packages -> ${pkg} ->" >&2
  echo "         Package settings -> Change visibility -> Public" >&2
  echo "       (CI cannot do this for you: GITHUB_TOKEN can push to a package but cannot" >&2
  echo "       change its visibility.)" >&2
}

# Pull one chart at $CHART_VERSION, waiting out a publish that is still running,
# and print the digest helm reports for what it pulled. Prints ONLY the digest
# on stdout — every progress and error line goes to stderr, because callers
# capture this in `$(…)`. The pulled tarball is left in $CHART_DIR.
#
# $1 = chart name, $2 = how many seconds to keep waiting. The budget is a
# parameter because the two charts publish at very different points in a run
# (see OBS_DIGEST_WAIT_TIMEOUT_S), so one number cannot be right for both.
resolve_chart_digest() {
  # `ref` cannot read `name` in the same `local` (shellcheck SC2318), so both
  # come from "$1".
  local name="$1" ref="${CHART_REPO}/${1}" budget="$2" out lower digest rc started deadline now attempt=0
  started="$(date +%s)"
  deadline=$(( started + budget ))
  while :; do
    # helm prints `Pulled:` and `Digest:` on stdout and its errors on stderr, so
    # both streams are captured together and classified below.
    rc=0
    out="$(helm pull "$ref" --version "$CHART_VERSION" -d "$CHART_DIR" 2>&1)" || rc=$?
    if [ "$rc" -eq 0 ]; then
      digest="$(printf '%s\n' "$out" | awk '$1 == "Digest:" { print $2 }' | tail -1)"
      # A pull that printed no digest would leave this empty, and an empty
      # digest silently degrades the deploy below to the version tag. Refuse it.
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || {
        echo "ERROR: helm pulled ${ref}:${CHART_VERSION} but reported no sha256 digest:" >&2
        printf '%s\n' "$out" >&2
        return 1
      }
      printf '%s' "$digest"
      return 0
    fi

    # Only a registry saying "I will not answer for this reference" is worth
    # waiting on. A DNS failure, a TLS error or a proxy refusing the connection
    # will not fix itself in 40 minutes, so those fail now with helm's own words
    # rather than being mistaken for a publish still in flight.
    lower="$(printf '%s' "$out" | tr '[:upper:]' '[:lower:]')"
    case "$lower" in
      *"not found"*|*denied*|*unauthorized*|*"manifest unknown"*) ;;
      *)
        echo "ERROR: could not read ${ref}:${CHART_VERSION} from the registry:" >&2
        printf '%s\n' "$out" >&2
        return 1
        ;;
    esac

    now="$(date +%s)"
    if [ "$now" -ge "$deadline" ]; then
      echo "ERROR: no chart published at ${ref}:${CHART_VERSION} after ${budget}s." >&2
      echo "       Commit $(git rev-parse HEAD) has no chart. Either publish is still" >&2
      echo "       running or it failed for this commit, or HEAD is not a commit that exists on" >&2
      echo "       origin/main (only pushed main commits are ever published)." >&2
      echo "       Check $PUBLISH_RUNS_URL, then re-run this script." >&2
      echo "       NOT deploying an older commit instead: silently running something other than" >&2
      echo "       the commit you asked for is the failure mode this whole path exists to remove." >&2
      ghcr_visibility_help "fortymm/charts/${name}"
      echo "       Last message from helm:" >&2
      printf '%s\n' "$out" >&2
      return 1
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -eq 1 ]; then
      echo "    ${ref}:${CHART_VERSION} not published yet — waiting up to ${budget}s." >&2
      # The two charts are missing for different reasons, so they get different
      # diagnoses. The stack chart job `needs` both image jobs; the
      # observability job `needs: [tag]` alone and never waits on an image, so
      # telling its operator to sit out an image build would be wrong.
      if [ "$name" = "$STACK_CHART" ]; then
        echo "    (the stack chart is published after the ~25 min multi-arch image build:" >&2
      else
        echo "    (this chart does NOT wait on the image build, so it should already exist —" >&2
        echo "     a missing one most likely means its job failed:" >&2
      fi
      echo "     $PUBLISH_RUNS_URL)" >&2
    elif [ $((attempt % 4)) -eq 0 ]; then
      echo "    still waiting for ${name} ${CHART_VERSION} ($(( now - started ))s elapsed of ${budget}s)" >&2
    fi
    sleep "$DIGEST_POLL_INTERVAL_S"
  done
}

echo
echo "==> Resolving the published $STACK_CHART chart at $CHART_VERSION"
STACK_CHART_DIGEST="$(resolve_chart_digest "$STACK_CHART" "$DIGEST_WAIT_TIMEOUT_S")" || exit 1
echo "    ${CHART_REPO}/${STACK_CHART}@${STACK_CHART_DIGEST}"

# Both charts resolve HERE, before anything is deployed. Resolving the second
# one after the stack was already upgraded, rolled out and polled would let a
# missing observability chart end the run with UAT half-deployed — the expensive
# half done, and no monitoring. Everything that can refuse to start the deploy
# does so before the deploy starts.
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  echo
  echo "==> Resolving the published $OBS_CHART chart at $CHART_VERSION"
  OBS_CHART_DIGEST="$(resolve_chart_digest "$OBS_CHART" "$OBS_DIGEST_WAIT_TIMEOUT_S")" || exit 1
  echo "    ${CHART_REPO}/${OBS_CHART}@${OBS_CHART_DIGEST}"
fi

# --- secrets ----------------------------------------------------------------
# Created from the gitignored source-of-truth files, never committed and never
# baked into the chart. Re-runnable via apply.
echo
echo "==> Syncing secrets from .env and $APNS_KEY"
[ -f .env ] || { echo "ERROR: .env not found (copy .env.example and fill in)." >&2; exit 1; }
[ -f "$APNS_KEY" ] || { echo "ERROR: $APNS_KEY not found." >&2; exit 1; }

# The tailscale proxy reads TS_AUTHKEY from the .env-backed secret. When it's
# enabled, fail fast with a clear message rather than a CrashLooping pod. The
# chart defaults tailscale.enabled to FALSE, so this file is the only thing that
# can turn it on for UAT and the only thing worth reading here.
ts_enabled=$(awk '/^tailscale:/{f=1;next} f&&/^[^[:space:]]/{f=0} f&&/^[[:space:]]+enabled:/{v=$2} END{print v}' "$STACK_VALUES")
if [ "$ts_enabled" = "true" ]; then
  grep -qE '^TS_AUTHKEY=.' .env || {
    echo "ERROR: TS_AUTHKEY missing/empty in .env (tailscale.enabled=true)." >&2
    echo "       Add a reusable auth key (Tailscale admin -> Settings -> Keys), or" >&2
    echo "       set tailscale.enabled=false in $STACK_VALUES to skip it." >&2
    exit 1
  }
fi

# The observability stack needs a Grafana admin password and (for its tailscale
# proxies) the same TS_AUTHKEY. Fail fast here rather than mid-deploy. The key is
# required unconditionally rather than read out of $OBS_VALUES the way
# tailscale.enabled is above: that chart's proxies are a LIST of hostnames, which
# no line-wise scan reads honestly, and UAT turns them on. Turn them off in
# $OBS_VALUES and this check becomes stricter than the deploy needs.
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
# The chart is named by DIGEST, not by version: the version was resolved above,
# and deploying the digest means the bytes installed are the bytes that resolve
# was answered with, whatever happens to a tag afterwards. Inside them are the
# image digests CI baked in, so the pods name `repository@sha256:…` without this
# script passing anything — two replicas cannot end up on different bytes. If
# this is the same commit that is already deployed the pod templates are
# unchanged and helm rolls nothing — correct, not a missed deploy.
helm upgrade --install "$RELEASE" "${CHART_REPO}/${STACK_CHART}@${STACK_CHART_DIGEST}" \
  --namespace "$NAMESPACE" \
  -f "$STACK_VALUES" \
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
# proxy (private MagicDNS hostname). Its subcharts are vendored INSIDE the
# published package by CI, so this path no longer adds the prometheus-community
# and grafana Helm repos or runs `helm dependency build` — a deploy reaches only
# ghcr.io.
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

  # Same commit, same version, same digest-pinned form as the stack chart. Its
  # digest was resolved before the stack deploy, so a missing chart stops the run
  # before it changes anything.
  echo
  echo "==> helm upgrade --install $OBS_RELEASE"
  helm upgrade --install "$OBS_RELEASE" "${CHART_REPO}/${OBS_CHART}@${OBS_CHART_DIGEST}" \
    --namespace "$OBS_NAMESPACE" \
    -f "$OBS_VALUES" \
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
echo "  commit $(git rev-parse HEAD) (published as $CHART_VERSION)"
echo "  ${CHART_REPO}/${STACK_CHART}@${STACK_CHART_DIGEST}"
echo "  values $STACK_VALUES"
if [ "$DEPLOY_OBSERVABILITY" = "true" ]; then
  echo "  ${CHART_REPO}/${OBS_CHART}@${OBS_CHART_DIGEST}"
  echo "  values $OBS_VALUES"
fi
