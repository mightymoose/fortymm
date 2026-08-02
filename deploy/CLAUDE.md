# CLAUDE.md — infra / deploy runbook

Operational runbook for the fortymm infra surface, and the source of truth for
the deploy topology — the UAT k3d/Helm chart, the QA/dev compose stacks,
Mailpit, the port map, `redeploy-uat.sh`, and the tailnet. The root `CLAUDE.md`
carries only the one-table summary. `## Topology` below is the detail;
`## Operational failure modes` is what bites in practice.

**The operator** is whoever runs the machine hosting UAT — its host
Caddy/DDNS/tailnet config and secret values live there, not in this repo.

## The surface

Infra has no single directory — it spans:

- `deploy/uat/` — Helm chart for the prod-like **UAT** stack on a local **k3d**
  cluster (postgres, redis, api ×5, worker, web-client ×2, routing nginx,
  optional tailscale proxy; migrate+seed as a `post-install,post-upgrade` hook Job).
- `deploy/observability/` — umbrella chart (kube-prometheus-stack + loki-stack
  + tempo) in the `monitoring` namespace, tailnet-only.
- `docker-compose.{dev,qa,e2e}.yml` — the compose stacks. There is **no**
  `docker-compose.uat.yml`: UAT is k3d/Helm only (the chart above).
- `nginx/` — `dev.conf` (web upstream :5173) and `uat.conf` (web upstream :80);
  `uat.conf` is mounted by the QA compose stack. The k8s routing nginx does NOT
  read this file — it renders an **inline copy** in
  `deploy/uat/templates/_helpers.tpl` (`fortymm-uat.nginxConf`, which also adds a
  `/faro/` block). When you touch `uat.conf`, update the helper copy too.
- `.github/workflows/*.yml` — CI (api, web-client, e2e, openapi-schema, ios, …).
- `mise.toml` — toolchain pins + task runner (`redeploy-uat`, `regen-*-types`).

## Stacks at a glance

| Stack | How | Host URL | Notes |
|-------|-----|----------|-------|
| dev   | `docker compose -f docker-compose.dev.yml up` | :8080 | dev servers, MSW off; real API |
| QA    | up `scripts/qa-up.sh [id]` / down `scripts/qa-down.sh [id]` | :8085 (auto) | built artifacts, MSW off, **Mailpit :8087** captures all mail; multi-stack; **reap on merge** |
| UAT   | `mise run redeploy-uat` | host :8084 → NodePort 30084 | **k3d/Helm — the one prod-like stack NOT on compose**; sends REAL Postmark email |

## Topology

**UAT runs on Kubernetes (Helm + k3d).** UAT is the one prod-like stack that does *not* use docker-compose. `scripts/redeploy-uat.sh` (a.k.a. `mise run redeploy-uat`) provisions a single-node **k3d** cluster `fortymm-uat`, builds the api/web images (same `api/Dockerfile.dev` + `web-client/Dockerfile.uat`), `k3d image import`s them, syncs Secrets from the gitignored `.env` + `secrets/*.p8`, and `helm upgrade --install`s the chart at **`deploy/uat/`**. The chart reproduces the old compose topology (postgres, redis, api, worker, web-client, routing nginx); migrations + seeds run as a `post-install,post-upgrade` Helm hook **Job** (not in the api boot command). Routing nginx is a **NodePort** (30084); k3d maps host **:8084** → that NodePort, so host Caddy (still pointing at `127.0.0.1:8084`) fronts uat.fortymm.com unchanged. Needs `helm` + `k3d` (`brew install helm k3d`). Inspect with `KUBECONFIG=$(k3d kubeconfig write fortymm-uat) kubectl get pods -n fortymm-uat`.

**UAT is also on the tailnet.** The chart runs a `tailscale/tailscale` proxy (`deploy/uat/templates/tailscale.yaml`, `tailscale.enabled` in values, on by default) that fronts the routing nginx via `tailscale serve`, so UAT is reachable privately at **`https://fortymm-uat.<tailnet>.ts.net`** with auto-HTTPS — independent of the DDNS/router/Caddy chain (which still serves `uat.fortymm.com` unchanged; Tailscale is purely additive). It reads `TS_AUTHKEY` (a reusable, non-ephemeral key from the Tailscale admin console) straight from the `.env`-backed secret, so just add a `TS_AUTHKEY=tskey-...` line to `.env`; `redeploy-uat.sh` errors early if it's missing. The proxy persists its node identity in the `tailscale-state` Secret (survives restarts; no re-auth). Requires HTTPS certs + MagicDNS enabled in the tailnet. Set `tailscale.enabled=false` to skip it.

Prod-like compose stacks (built artifacts, no dev server, isolated volumes; only nginx published):
- `docker compose -f docker-compose.qa.yml up -d --build` — `fortymm-qa`, nginx on **:8085**, local-only at http://127.0.0.1:8085. Same app shape as UAT, separate project/port/volumes. Tear down with **`scripts/qa-down.sh [id]`**, not `down -v` — the latter leaves the stack's built images and buildx cache behind (that leak once grew `Docker.raw` to 230 GB and wedged the daemon). To run **multiple QA stacks at once**, parameterize per stack: `QA_ID=<id> QA_PORT=<port> QA_MAILPIT_PORT=<port>` override the project name, nginx host port (+`APP_BASE_URL`), and Mailpit port. `scripts/qa-up.sh [id]` picks a free port trio automatically and prints the assigned URL.

**Preview-stack email.** The **QA** stack runs a `mailpit` service that captures *all* outbound email instead of relaying it through the real Postmark account in `.env`. Its api/worker `environment:` blocks override `SMTP_*` (`SMTP_HOST=mailpit`, `:1025`, no TLS, blank creds) so it can never send real mail — the worker's RQ `email` jobs (confirmation / magic-link sign-in / account-merge, see `api/app/email.py`) land in Mailpit. Read them at the Mailpit web UI: **QA → http://127.0.0.1:8087** (host-local only; not proxied by Caddy, since captured mail contains live sign-in links). QA also overrides `APP_BASE_URL` to `http://127.0.0.1:8085` so captured links are clickable. To verify a sign-in/confirmation flow on QA, trigger it in the UI then open the Mailpit UI to grab the link.

**UAT sends real email.** Unlike QA, the UAT stack does *not* run Mailpit — it relays through the live Postmark account configured by `SMTP_*` in `.env`. Mail triggered on UAT lands in real inboxes.

## Common commands

```bash
mise run redeploy-uat                 # rebuild + helm upgrade the k3d UAT stack, smoke-check uat.fortymm.com
DEPLOY_OBSERVABILITY=false mise run redeploy-uat   # skip the monitoring chart
scripts/qa-up.sh [id]                 # bring up an isolated QA stack on a free port trio; prints QA_URL / Mailpit URL
scripts/qa-down.sh [id]               # reap that stack: containers, volumes (named + anonymous), networks, built images
scripts/qa-down.sh --dry-run [id]     # preview what would be removed
scripts/qa-down.sh --all              # every fortymm-qa-* stack (k3d/UAT resources are guarded)
scripts/qa-down.sh --all --prune-cache  # ...plus the GLOBAL buildx cache (opt-in; next build is cold everywhere)

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
  **[destructive/shared]** — `DROP SCHEMA` wipes all UAT data; confirm with the
  user before running it.

### Observability deploy hangs — release stuck in `pending-upgrade` behind a Terminating `loki-0`

- **Symptom:** `mise run redeploy-uat` hangs on the monitoring chart. `helm list
  -n monitoring` shows `pending-upgrade` with **no helm process running**, so it
  never resolves; every later upgrade then fails with *"another operation
  (install/upgrade/rollback) is in progress"*. `kubectl get pods -n monitoring`
  shows `loki-0` in `Terminating` — often for over an hour. Each retry strands
  another revision.
- **Cause:** two things compounding. The k3d node flaps `NotReady` (Docker
  Desktop strain / host sleep) and the node controller evicts `loki-0`
  (`DisruptionTarget: True`). Loki is typically already sick — 503 on its
  readiness probe, many restarts — and **doesn't exit on SIGTERM**. The loki
  subchart ships `terminationGracePeriodSeconds: 4800` (**80 minutes**), which
  the kubelet honours in full before SIGKILL. A StatefulSet can't recreate
  ordinal 0 until the old pod is gone, so `helm upgrade --wait` blocks on it.
  We now pin this to 60s in `deploy/observability/values.yaml` — but the guard
  only helps once a *successful* upgrade has applied it.
- **Reading the clock:** `metadata.deletionTimestamp` is the moment the grace
  period **expires**, not when deletion was requested. Subtract the grace period
  to get the eviction time:
  ```bash
  kubectl get pod loki-0 -n monitoring \
    -o jsonpath='{.metadata.deletionTimestamp} {.metadata.deletionGracePeriodSeconds}'
  ```
- **Waiting does NOT fix it.** When the grace period expires the kubelet SIGKILLs
  the pod and the StatefulSet recreates it, so the *pods* go healthy on their
  own — but the release stays `pending-upgrade` forever, because no helm process
  is alive to finish or fail it. The rollback below is mandatory; the
  force-delete only buys back the remaining grace-period minutes.
- **Fix (clear the stranded release, then the pod):** Loki here has **no PVC**
  and its storage renders as `emptyDir: {}`, so force-deleting loses nothing that
  wasn't already ephemeral:
  ```bash
  # Required — nothing else clears `pending-upgrade`:
  helm --kube-context k3d-fortymm-uat rollback observability <last-deployed-rev> -n monitoring
  # Optional — skips the wait for SIGKILL:
  kubectl --context k3d-fortymm-uat delete pod loki-0 -n monitoring --grace-period=0 --force
  helm --kube-context k3d-fortymm-uat list -n monitoring   # expect: deployed
  ```
  Use `helm history observability -n monitoring` to find the last `deployed`
  revision. `helm rollback` is the way out of `pending-upgrade`; a plain
  `helm upgrade` will just refuse. **[destructive/shared]** — flag for the user;
  do not run unprompted.
- **Mind the kube context.** The default context is usually `docker-desktop`,
  **not** the k3d cluster, and both tools fail *quietly* against the wrong one:
  `helm list -n monitoring` returns an empty table and
  `helm rollback ...` says `Error: release: not found` — neither of which reads
  like "you're pointed at the wrong cluster". Pass
  `--kube-context k3d-fortymm-uat` / `--context k3d-fortymm-uat` as above, or
  `export KUBECONFIG="$(k3d kubeconfig write fortymm-uat)"` once per shell.
- **Sidestep it:** `DEPLOY_OBSERVABILITY=false mise run redeploy-uat` deploys the
  app without touching the monitoring chart, so a wedged Loki doesn't block
  shipping UAT.

### Compose nginx 502 with stale upstream IPs

- **Symptom:** After recreating `api`/`web-client` in a compose stack, nginx
  returns 502.
- **Cause:** The compose nginx resolves `api:8000` / `web-client:80` to IPs
  **once at startup** and caches them; recreated containers get new IPs.
- **Fix:** `docker compose -f docker-compose.<stack>.yml restart nginx`.
- **Scope:** compose stacks only — **dev / qa / e2e**. The **k3d UAT is
  immune** (and has no compose stack to restart): its nginx upstreams are
  Kubernetes Services, so this specific stale-IP 502 doesn't apply there.

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

The exact router/DDNS/Caddy chain and secret *values* live in the **operator's
environment**, not in any checked-in file. `## Topology` above documents the
repo-general shape (chart, stacks, ports, mail routing); don't hardcode
host-specific wiring or credentials into it.
