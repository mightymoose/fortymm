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
- `.github/workflows/*.yml` — CI (api, web-client, e2e, openapi-schema, ios, …),
  including **`publish-images.yml`**, which pushes the api/web images to GHCR on
  every push to `main` (see `## Published images (GHCR)`).
- `mise.toml` — toolchain pins + task runner (`redeploy-uat`, `regen-*-types`).

## Stacks at a glance

| Stack | How | Host URL | Notes |
|-------|-----|----------|-------|
| dev   | `docker compose -f docker-compose.dev.yml up` | :8080 | dev servers, MSW off; real API |
| QA    | up `scripts/qa-up.sh [id]` / down `scripts/qa-down.sh [id]` | :8085 (auto) | built artifacts, MSW off, **Mailpit :8087** captures all mail; multi-stack; **reap on merge** |
| UAT   | `mise run redeploy-uat` | host :8084 → NodePort 30084 | **k3d/Helm — the one prod-like stack NOT on compose**; sends REAL Postmark email |

## Published images (GHCR)

`.github/workflows/publish-images.yml` builds the two Dockerfiles UAT runs —
`api/Dockerfile.dev` and `web-client/Dockerfile.uat` — and pushes them to two
GHCR packages:

- `ghcr.io/mightymoose/fortymm-api`
- `ghcr.io/mightymoose/fortymm-web-client`

**Trigger: every push to `main`** (plus a manual `workflow_dispatch`, which the
first job rejects on any ref but `main`, since a non-main run would move the
`:main` tag onto an unreviewed commit). Deliberately **not** on `pull_request` —
an image built from a PR head is not deployable, so it would burn ~25 minutes of
runner to produce something nothing can consume. Also deliberately **not**
path-filtered: the deploy path this is groundwork for deploys **main's tip** and
looks the images up by that commit's SHA, so whatever commit is currently the tip
needs images no matter what it touched — and a docs-only commit is very often the
tip.

**It does not follow that every commit on `main` gets images, and nothing here
promises that.** Runs are serialized per ref and a run already in progress is
never cancelled, but GitHub *does* cancel a **pending** run when a newer one
queues into the same concurrency group. Merge three times inside one ~25-minute
build window and the middle commit publishes nothing. That is tolerable only
because the tip is the sole thing ever deployed and the newest queued run is the
one that survives — so the tip always publishes. If you ever need to deploy a
specific historical commit rather than the tip, check that its tag actually
exists before assuming it does.

**Two tags per image per run:** `:<12-char sha>` (one per commit — nothing
registry-side pins it, so a re-run for the same commit overwrites it) and
`:main` (moving, always the newest `main`). Push credentials are the built-in
`GITHUB_TOKEN` with `packages: write` — there is no registry secret to rotate.

**The tag is a fixed 12-character truncation of the full commit SHA**
(`${GITHUB_SHA::12}`), deliberately **not** `git rev-parse --short`. `--short`
picks its length from the repository's object count (`core.abbrev=auto`) and from
any `core.abbrev` the operator has set, so the same commit abbreviates to 7 in a
shallow CI clone, 8 in a full clone of this repo today, and 9 once it grows.
Anything looking an image up by tag must use the same fixed truncation or it gets
a tag-not-found on a commit that published perfectly well. Hand-pulling:

```bash
docker pull "ghcr.io/mightymoose/fortymm-api:$(git rev-parse HEAD | cut -c1-12)"
```

**Each tag is a multi-arch manifest list — `linux/amd64` *and* `linux/arm64`.**
UAT's k3d cluster runs on the operator's own machine rather than on an amd64
runner, and that machine's architecture is not something this repo pins or can
check — an amd64-only image would either fail to run there or run under
emulation, depending on whose machine it is. A later Hetzner box is amd64, so
one manifest list per tag serves both. The arm64 leg is QEMU-emulated on the
amd64 runner and dominates the run — **~25 min is normal** (the jobs allow 90).
Provenance attestations are off, so each index holds exactly the two platform
manifests it claims and nothing pinning it by digest sees an `unknown/unknown`
entry.

Nothing consumes these images yet: `mise run redeploy-uat` still builds locally
and `k3d image import`s (see `## Topology`). This section documents the
publishing half only.

### One-time per package: flip visibility to public

**GHCR publishes a package private on its first push — even from a public
repository. Visibility is not inherited from the repo.** After the first
successful run that creates a package, someone with admin on the repo must flip
it by hand:

> repository → **Packages** → the package → **Package settings** → **Change
> visibility** → **Public**

This is needed **once per package**, so twice in total (`fortymm-api`,
`fortymm-web-client`), and never again — subsequent pushes keep the visibility
the package already has. **The workflow cannot do it:** `GITHUB_TOKEN` can push
to a package with `packages: write` but cannot change its visibility, so there is
no way to automate this from CI with the built-in token.

Until the flip, **nothing can pull these images anonymously** — an
unauthenticated `docker pull` / `docker buildx imagetools inspect` fails with
`denied` or `unauthorized`, and it fails that way whether or not the repo itself
is public. If a pull is denied, check package visibility *before* you suspect the
tag. Public packages are also why no downstream consumer will need registry
credentials or an `imagePullSecrets` entry.

### `VITE_GOOGLE_MAPS_API_KEY` — optional repository secret

`VITE_*` values are baked into the bundle at build time, so the web image's are
fixed by the workflow rather than by the operator's `.env`. It passes two build
args: `VITE_FARO_COLLECTOR_URL=/faro/collect` unconditionally (a same-origin
path, not a secret — where nginx has no `/faro/` block the beacons just 404), and
`VITE_GOOGLE_MAPS_API_KEY` from the repository secret of the same name.

That secret is **optional**. Unset, it expands to empty, which matches
`web-client/Dockerfile.uat`'s own default (`ARG VITE_GOOGLE_MAPS_API_KEY=""`):
the build still succeeds and the shipped bundle degrades the venue map to a text
fallback. Nothing here fails on a missing key.

It is the **browser** Maps JS key — readable in the shipped bundle either way —
and is *not* the server-side `GOOGLE_GEOCODING_API_KEY`, which stays a runtime
secret in `.env`. Because one published bundle is served from every origin we
deploy it to, its Google-console restrictions must cover **all** of them
(`uat.fortymm.com`, the host `:8084` origin, the `https://fortymm-uat.<tailnet>.ts.net`
name, plus any later prod origin) — a restriction list that misses one origin
breaks the map only on that origin.

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
