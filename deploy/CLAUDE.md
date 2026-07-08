# CLAUDE.md — infra / deploy runbook

Operational runbook for the fortymm infra surface. This is where the deploy
topology gets *operated*, not re-explained: the root `CLAUDE.md` is the source
of truth for the topology (UAT k3d/Helm chart, QA/dev/compose stacks, Mailpit,
port map, `redeploy-uat.sh`, tailnet). Read the root's infra sections first,
then use this file for the failure modes that bite in practice.

## The surface

Infra has no single directory — it spans:

- `deploy/uat/` — Helm chart for the prod-like **UAT** stack on a local **k3d**
  cluster (postgres, redis, api ×5, worker, web-client ×2, routing nginx,
  optional tailscale proxy; migrate+seed as a post-upgrade hook Job).
- `deploy/observability/` — umbrella chart (kube-prometheus-stack + loki-stack
  + tempo) in the `monitoring` namespace, tailnet-only.
- `docker-compose.{dev,qa,e2e,uat}.yml` — compose stacks (UAT compose is a
  documented fallback; the live UAT is k3d/Helm, above).
- `nginx/` — `dev.conf` (web upstream :5173) and `uat.conf` (web upstream :80);
  `uat.conf` is shared by the QA compose stack and the k8s routing nginx.
- `.github/workflows/*.yml` — CI (api, web-client, e2e, openapi-schema, ios, …).
- `mise.toml` — toolchain pins + task runner (`redeploy-uat`, `regen-*-types`).

## Stacks at a glance

| Stack | How | Host URL | Notes |
|-------|-----|----------|-------|
| dev   | `docker compose -f docker-compose.dev.yml up` | :8080 | dev servers, MSW off; real API |
| QA    | `scripts/qa-up.sh [id]` | :8085 (auto) | built artifacts, MSW off, **Mailpit :8087** captures all mail; multi-stack |
| UAT   | `mise run redeploy-uat` | host :8084 → NodePort 30084 | **k3d/Helm — the one prod-like stack NOT on compose**; sends REAL Postmark email |

See the root `CLAUDE.md` for the full topology (Caddy/DDNS/tailnet chain, port
table, Mailpit, secrets). Don't duplicate it here.

## Common commands

```bash
mise run redeploy-uat                 # rebuild + helm upgrade the k3d UAT stack, smoke-check uat.fortymm.com
DEPLOY_OBSERVABILITY=false mise run redeploy-uat   # skip the monitoring chart
scripts/qa-up.sh [id]                 # bring up an isolated QA stack on a free port trio; prints QA_URL / Mailpit URL

# Inspect UAT (point kubectl/helm at the k3d cluster first):
export KUBECONFIG="$(k3d kubeconfig write fortymm-uat)"
kubectl get pods -n fortymm-uat
kubectl logs -n fortymm-uat deploy/api --tail=40
kubectl get pods -n monitoring        # observability
```

## Operational failure modes

Each is symptom → cause → fix. Fixes marked **[destructive/shared]** mutate a
shared local cluster or stack — **flag them for the user; do not run them
unprompted.**

### UAT redeploy lands stale code — blank white page (~50% of loads)

- **Symptom:** After a redeploy the UAT SPA is blank/white for roughly half of
  page loads (reads as "broken in Safari"). `curl -s :8084/` in a loop shows the
  `assets/index-*.js` entry hash flipping between two values; the browser fetches
  `index.html` from one web pod but its hashed JS chunk 404s because it was
  routed (round-robin, no session affinity) to the *other* web pod running a
  different built bundle.
- **Cause:** The two `web-client` replicas are on **different image digests**.
  This happens when the unique-tag scheme is bypassed — re-importing content
  under the mutable `:uat` tag (still the `values.yaml` default) that only one
  pod picks up, a manual `helm upgrade` without `--set images.*.tag=<unique>`,
  or a single web pod rescheduling and drifting from its sibling. `helm upgrade`
  then sees an unchanged pod template (`pullPolicy: IfNotPresent`) and keeps old
  pods running stale code.
- **`mise run redeploy-uat` prevents this by design:** it tags every build
  `$(git short-sha)-$(epoch)` and passes `--set images.{api,web}.tag`, so the pod
  template changes and both deployments roll atomically (zero-downtime
  RollingUpdate, `maxUnavailable: 0`). **Use the script, not a bare
  `helm upgrade`.**
- **Fix (if it bites):** diagnose by comparing `imageID` across the two web pods
  (`kubectl get pods -n fortymm-uat -l ... -o jsonpath` / describe) — if they
  differ, `kubectl rollout restart deploy/web-client -n fortymm-uat` converges
  them. **[destructive/shared]** — a rollout restart on shared UAT is the user's
  call.

### UAT DB keeps the OLD schema — every endpoint on a changed table 500s

- **Symptom:** New code is live but every authed BFF endpoint touching a changed
  table returns 500; the served `openapi.json` has the new paths but the DB is
  missing the new columns.
- **Cause:** Migrations are edited **in place** with frozen revision ids
  (fortymm is undeployed — see the pre-deploy migration convention), but UAT's
  Postgres runs on a **persisted PVC** (`postgres.yaml`, 5Gi `local-path`). The
  migrate Job runs a bare `alembic upgrade head`, which sees the same revision
  already in `alembic_version` and no-ops — so the schema never advances while
  the new code expects it.
- **Fix (wipe + re-migrate):** scale api/worker to 0, drop and recreate the
  schema, then `helm upgrade` to re-fire the post-upgrade migrate+seed hook Job:
  ```bash
  kubectl scale deploy/api deploy/worker --replicas=0 -n fortymm-uat
  # psql into the postgres pod, then:  DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  helm upgrade ...            # re-runs the migrate Job against the empty schema
  ```
  **[destructive/shared]** — `DROP SCHEMA` wipes all UAT data. **Always flag for
  the user; never run unprompted.**

### Compose nginx 502 with stale upstream IPs

- **Symptom:** After recreating `api`/`web-client` in a compose stack, nginx
  returns 502.
- **Cause:** The compose nginx resolves `api:8000` / `web-client:80` to IPs
  **once at startup** and caches them; recreated containers get new IPs.
- **Fix:** `docker compose -f docker-compose.<stack>.yml restart nginx`.
- **Scope:** compose stacks only (dev / qa / compose-uat fallback). The **k3d
  UAT is immune** — its nginx upstreams are Kubernetes Services, so this
  specific stale-IP 502 doesn't apply there.

### QA `up --build` serves STALE code (two independent caches)

1. **BuildKit layer cache** — `RUN npm run build` (and the API build) can be
   served from a cached layer, so a "fresh" image contains old source. **Verify
   the served bundle before trusting QA:** `curl :8085/` and grep the hashed
   chunks / a known feature string, and check `openapi.json`. **Fix:**
   `docker compose ... build --no-cache <svc>` then
   `up -d --no-deps --force-recreate <svc>` + `restart nginx`.
2. **PWA service worker** — `sw.js` caches `index.html` + assets browser-side, so
   a browser already on the page keeps the OLD bundle after a rebuild.
   **Fix:** unregister the SW and clear caches
   (`getRegistrations()→unregister()`, `caches.keys()→delete`), then hard reload.

### Caddy :443 bind conflict — uat.fortymm.com times out but :8084 is green

- **Symptom:** `uat.fortymm.com` times out, yet
  `curl 127.0.0.1:8084/api/v1/health` is green.
- **Cause:** host Caddy (the TLS terminator) is in `error` —
  `listening on :443: bind: address already in use` — because a `tailscale serve`
  config grabbed :443.
- **Fix:** `tailscale serve reset`, then `brew services restart caddy`; verify
  with `lsof -iTCP:443` (should show caddy). Host-specific — see the operator's
  environment for the full chain.

### QA stacks OOM under load

- **Symptom:** With ~8 concurrent `fortymm-qa` stacks + a heavy Workflow, Docker
  OOM-kills containers across stacks; a freshly-built stack can exit 0 yet be
  dead minutes later (api OOM-cycles, health flatlines 000/502).
- **Cause:** host memory exhaustion.
- **Fix:** don't restart-loop a dead api under memory pressure — reduce the
  number of concurrent stacks.

## Verify after any UAT/QA deploy

1. Served `openapi.json` has the new paths (`curl <url>/openapi.json | jq`).
2. The DB actually has the new columns (psql into the pod/container).
3. Authed BFF endpoints return **200, not 500**.
4. Web entry hash is stable across reloads (`curl -s <url>/` in a loop — the
   `assets/index-*.js` hash must not flip).
5. On k3d UAT, both `web-client` pods share **one `imageID`** (no digest drift) —
   this is exactly what the unique-tag scheme guarantees and a manual
   `helm upgrade` breaks.

## Note on host-specific details

The exact router/DDNS/Caddy/tailnet chain, precise port assignments, and secret
locations live in the **operator's environment and the root `CLAUDE.md`**, not
here. This runbook stays repo-general; don't hardcode host specifics into it.
