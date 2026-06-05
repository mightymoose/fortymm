#!/usr/bin/env bash
# Rebuild and restart the fortymm-uat docker stack, then smoke-check
# https://uat.fortymm.com. Run from anywhere — the script cd's to the
# repo root.
#
# Run from `main` or the legacy `uat-deploy` worktree. The UAT-only config
# (this script, docker-compose.uat.yml, the nginx UAT confs, Dockerfile.uat)
# now lives on main, so deploying straight from a main checkout works. Each
# run fetches origin/main and merges it into the current branch, so deploys
# always reflect the latest main.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE=(docker compose -f docker-compose.uat.yml)
UAT_URL="${UAT_URL:-https://uat.fortymm.com}"

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

echo
echo "==> Building images and (re)starting containers"
"${COMPOSE[@]}" up -d --build

# Nginx caches resolved upstream IPs at startup. When `up` recreates api or
# web-client but leaves nginx alone, those IPs become stale and nginx returns
# 502 until restarted. Force a restart so we always pick up fresh upstreams.
echo
echo "==> Restarting nginx to refresh upstream IPs"
"${COMPOSE[@]}" restart nginx

echo
echo "==> Waiting for api to finish migrations and report healthy"
deadline=$(( $(date +%s) + 90 ))
until curl -fsS --max-time 3 "$UAT_URL/api/v1/health" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: $UAT_URL/api/v1/health did not respond within 90s" >&2
    echo "--- recent api logs ---" >&2
    "${COMPOSE[@]}" logs --tail=40 api >&2 || true
    exit 1
  fi
  sleep 2
done

echo
echo "==> Container status"
"${COMPOSE[@]}" ps

echo
echo "==> Health"
curl -fsS "$UAT_URL/api/v1/health"
echo
echo "Redeployed: $UAT_URL"
