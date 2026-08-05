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
  cluster (postgres, redis, api ×2, worker, web-client ×2, routing nginx,
  optional tailscale proxy; migrate+seed as a `post-install,post-upgrade` hook
  Job, retirement sweep as a CronJob). The api and web images are **pulled from
  GHCR and pinned by digest** — nothing in this chart is built locally.
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
  including **`publish.yml`**, which pushes the api/web images to GHCR on
  every push to `main` (see `## Published images (GHCR)`).
- `mise.toml` — toolchain pins (node, python, `helm`, `k3d`) + task runner:
  `redeploy-uat` (deploy published, digest-pinned images to k3d), `qa-down`,
  `regen-*-types`, `ios-testflight`, and `release-beta` (UAT then TestFlight).

## Stacks at a glance

| Stack | How | Host URL | Notes |
|-------|-----|----------|-------|
| dev   | `docker compose -f docker-compose.dev.yml up` | :8080 | dev servers, MSW off; real API |
| QA    | up `scripts/qa-up.sh [id]` / down `scripts/qa-down.sh [id]` | :8085 (auto) | built artifacts, MSW off, **Mailpit :8087** captures all mail; multi-stack; **reap on merge** |
| UAT   | `mise run redeploy-uat` | host :8084 → NodePort 30084 | **k3d/Helm — the one prod-like stack NOT on compose**; deploys **CI-published GHCR images pinned by digest** (builds nothing, so a merge isn't deployable until `publish` finishes); sends REAL Postmark email |

## Published images (GHCR)

`.github/workflows/publish.yml` builds the two Dockerfiles UAT runs —
`api/Dockerfile.dev` and `web-client/Dockerfile.uat` — and pushes them to two
GHCR packages:

- `ghcr.io/mightymoose/fortymm-api`
- `ghcr.io/mightymoose/fortymm-web-client`

**Trigger: every push to `main`** (plus a manual `workflow_dispatch`, which the
first job rejects on any ref but `main`, since a non-main run would move the
`:main` tag onto an unreviewed commit). Deliberately **not** on `pull_request` —
an image built from a PR head is not deployable, so it would burn ~25 minutes of
runner to produce something nothing can consume. Also deliberately **not**
path-filtered: `redeploy-uat.sh` deploys **main's tip** and looks the images up
by that commit's SHA, so whatever commit is currently the tip needs images no
matter what it touched — and a docs-only commit is very often the tip.

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

**UAT consumes these images.** `mise run redeploy-uat` builds nothing: it
resolves the deploying commit's `:<12-char sha>` tag to that manifest list's
digest and deploys `repository@sha256:…` (see `## Topology` for the consuming
half). The practical consequence is that **a merge is not deployable until this
workflow has finished for it** — the deploy script waits for the digest rather
than quietly deploying an older commit.

### Package visibility — public automatically, no manual step

**Both packages came out public on the very first publish, with no manual
step.** A package pushed by a workflow using `GITHUB_TOKEN` with
`packages: write` is automatically *linked* to the repository that published it
and inherits that repository's visibility — and this repo is public. Verified
against the first run (commit `b17a29fa`): an unauthenticated pull of both
`fortymm-api` and `fortymm-web-client` returned their manifests immediately.

This corrects what this file and
`docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md` originally
claimed. Both said GHCR publishes private on first push even from a public repo
and that someone must flip each package by hand under *Package settings →
Change visibility*. **That rule is real but does not apply here** — it governs
packages published with a *personal access token* that are not linked to a
repository. Nothing was flipped by hand for these two, and nothing needs to be.

Public packages are why no downstream consumer needs registry credentials and
why the chart carries no `imagePullSecrets`.

If an anonymous pull ever *is* denied (`denied` / `unauthorized` from
`docker pull` or `docker buildx imagetools inspect`), the likely causes are that
the package's visibility was changed by hand afterwards, or that the repository
itself went private — check visibility before you suspect the tag.
`redeploy-uat.sh` preflights this on every deploy and prints the click-path,
so the guard remains even though the routine case needs it.

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

**UAT runs on Kubernetes (Helm + k3d).** UAT is the one prod-like stack that does *not* use docker-compose. `scripts/redeploy-uat.sh` (a.k.a. `mise run redeploy-uat`) **builds nothing** — it deploys the images CI already published for the commit being deployed. It refuses any branch but `main` (or the legacy `uat-deploy` worktree), merges `origin/main` into it first so the deploy names the newest main, provisions a single-node **k3d** cluster `fortymm-uat`, resolves each package's `:<12-char sha>` tag to its **manifest-list digest** over the GHCR v2 API, syncs Secrets from the gitignored `.env` + `secrets/*.p8`, and `helm upgrade --install`s the chart at **`deploy/uat/`** with `--set images.api.digest=sha256:… --set images.web.digest=sha256:…` (`--wait --timeout 5m`). The chart reproduces the old compose topology (postgres, redis, api, worker, web-client, routing nginx); migrations + seeds run as a `post-install,post-upgrade` Helm hook **Job** (not in the api boot command). Routing nginx is a **NodePort** (30084); k3d maps host **:8084** → that NodePort, so host Caddy (still pointing at `127.0.0.1:8084`) fronts uat.fortymm.com unchanged. Needs `helm` + `k3d` (`brew install helm k3d`). Inspect with `KUBECONFIG=$(k3d kubeconfig write fortymm-uat) kubectl get pods -n fortymm-uat`.

**Why a digest and not the tag.** `fortymm-uat.imageRef` in `_helpers.tpl` renders `repository@sha256:…` whenever a digest is set, and every workload that runs app code (api, worker, migrate Job, retirement CronJob, web-client) goes through it. A digest is content-addressed, so "every replica runs the same bytes" stops being a convention the deploy script has to maintain and becomes structural — two pods naming one digest *cannot* be running different content, and re-running the publish workflow for an already-published commit cannot change what UAT is serving the way overwriting a `:<sha>` tag would. Empty `digest` in `values.yaml` falls back to `repository:tag` (the moving `:main`) purely so `helm template deploy/uat` renders on its own; a real deploy always passes digests, and a set-but-malformed one fails the render rather than being tolerated. The old `$(short-sha)-$(epoch)` unique-tag scheme is gone and should not come back — it existed because a *local* rebuild could produce different content under one commit, so the pod template had to change to force a roll. Published images are immutable, so a same-commit redeploy is a correct no-op. See `docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md`.

**Deploying now depends on CI.** The images for a commit exist only once `publish.yml` has finished for it (~25 min, dominated by the emulated arm64 leg), so a just-merged commit is not immediately deployable. The script polls GHCR every 30s for up to `DIGEST_WAIT_TIMEOUT_S` (default `2400`, i.e. 40 min) and then fails naming the commit and linking the workflow runs, rather than deploying an older commit without saying so. `DIGEST_WAIT_TIMEOUT_S=0` fails immediately instead of waiting. The anonymous digest read doubles as the public-visibility preflight (see the one-time flip under `## Published images (GHCR)`): if it resolves, the cluster can pull, which is why the chart carries no `imagePullSecrets` — and a package still private fails here with the click-path instead of dying as an `ErrImagePull` five minutes into `helm --wait`.

**UAT is also on the tailnet.** The chart runs a `tailscale/tailscale` proxy (`deploy/uat/templates/tailscale.yaml`, `tailscale.enabled` in values, on by default) that fronts the routing nginx via `tailscale serve`, so UAT is reachable privately at **`https://fortymm-uat.<tailnet>.ts.net`** with auto-HTTPS — independent of the DDNS/router/Caddy chain (which still serves `uat.fortymm.com` unchanged; Tailscale is purely additive). It reads `TS_AUTHKEY` (a reusable, non-ephemeral key from the Tailscale admin console) straight from the `.env`-backed secret, so just add a `TS_AUTHKEY=tskey-...` line to `.env`; `redeploy-uat.sh` errors early if it's missing. The proxy persists its node identity in the `tailscale-state` Secret (survives restarts; no re-auth). Requires HTTPS certs + MagicDNS enabled in the tailnet. Set `tailscale.enabled=false` to skip it.

Prod-like compose stacks (built artifacts, no dev server, isolated volumes; only nginx published):
- `docker compose -f docker-compose.qa.yml up -d --build` — `fortymm-qa`, nginx on **:8085**, local-only at http://127.0.0.1:8085. Same app shape as UAT, separate project/port/volumes. Tear down with **`scripts/qa-down.sh [id]`**, not `down -v` — the latter leaves the stack's built images and buildx cache behind (that leak once grew `Docker.raw` to 230 GB and wedged the daemon). To run **multiple QA stacks at once**, parameterize per stack: `QA_ID=<id> QA_PORT=<port> QA_MAILPIT_PORT=<port>` override the project name, nginx host port (+`APP_BASE_URL`), and Mailpit port. `scripts/qa-up.sh [id]` picks a free port trio automatically and prints the assigned URL.

**Preview-stack email.** The **QA** stack runs a `mailpit` service that captures *all* outbound email instead of relaying it through the real Postmark account in `.env`. Its api/worker `environment:` blocks override `SMTP_*` (`SMTP_HOST=mailpit`, `:1025`, no TLS, blank creds) so it can never send real mail — the worker's RQ `email` jobs (confirmation / magic-link sign-in / account-merge, see `api/app/email.py`) land in Mailpit. Read them at the Mailpit web UI: **QA → http://127.0.0.1:8087** (host-local only; not proxied by Caddy, since captured mail contains live sign-in links). QA also overrides `APP_BASE_URL` to `http://127.0.0.1:8085` so captured links are clickable. To verify a sign-in/confirmation flow on QA, trigger it in the UI then open the Mailpit UI to grab the link.

**UAT sends real email.** Unlike QA, the UAT stack does *not* run Mailpit — it relays through the live Postmark account configured by `SMTP_*` in `.env`. Mail triggered on UAT lands in real inboxes.

## Common commands

```bash
mise run redeploy-uat                 # helm upgrade the k3d UAT stack onto this commit's published GHCR images (digest-pinned); smoke-check uat.fortymm.com
DEPLOY_OBSERVABILITY=false mise run redeploy-uat   # skip the monitoring chart
DIGEST_WAIT_TIMEOUT_S=0 mise run redeploy-uat      # don't wait on publish; fail now if this commit has no images
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
- **Cause:** The two `web-client` replicas are serving **different builds**.
  Kubernetes cannot see this — the readiness probe is `GET /`, which any bundle
  answers 200 — so both pods are Ready and the Service round-robins between two
  incompatible SPAs.
- **The original cause is now structurally impossible.** It was a *mutable tag*:
  content re-imported under `:uat`, which only one pod ever picked up, plus
  `pullPolicy: IfNotPresent` leaving `helm upgrade` with an unchanged pod
  template and no reason to roll. Pods now name `repository@sha256:<digest>`
  (`fortymm-uat.imageRef`), and a digest is content-addressed: two replicas
  naming one digest cannot be running different bytes, whenever either of them
  was scheduled. That also retires the `$(short-sha)-$(epoch)` tag scheme that
  used to be the countermeasure — see `## Topology`.
- **What can still produce it:**
  1. **A deploy that reached the chart's tag fallback instead of a digest.**
     With `images.*.digest` empty the chart renders `repository:main` — and
     `:main` moves on every push to `main`. Under `IfNotPresent` each pod
     resolves that string only when it actually pulls, so a pod created before a
     merge and its replacement created after one sit on different images with an
     identical pod template, and Helm rolls nothing. This is the old failure
     mode wearing a new tag. Reached by a bare `helm upgrade`/`helm install`
     without `--set images.{api,web}.digest=`, or by `helm template` piped into
     `kubectl apply`. `redeploy-uat.sh` is the **only** thing that supplies the
     digests, and it asserts their shape before deploying precisely because an
     *empty* digest is not malformed to the chart — it is the documented
     render-only fallback, so it would deploy the moving tag in silence.
     **Use the script, not a bare `helm upgrade`** — more load-bearing now, not
     less.
  2. **Mid-rollout, briefly and legitimately.** `maxUnavailable: 0` +
     `maxSurge: 1` means old and new Ready pods overlap by design, so the entry
     hash flips while a deploy is in flight. It is only a bug if it persists
     after `kubectl rollout status deploy/web-client -n fortymm-uat` returns.
  3. **Not the pods at all.** If both pods share one `imageID` and the hash
     still flips, the divergence is above them: a PWA service worker holding an
     old `index.html` browser-side (see the QA entry below), or a second stack
     answering on the same host port.
- **Fix (if it bites):** compare `imageID` across the two web pods
  (`kubectl get pods -n fortymm-uat -l app.kubernetes.io/component=web -o
  jsonpath='{.items[*].status.containerStatuses[*].imageID}'`). If they differ,
  check what the pod template actually names:
  `kubectl get deploy/web-client -n fortymm-uat -o jsonpath='{.spec.template.spec.containers[0].image}'`
  — a `…:main` there rather than `…@sha256:…` means the deploy bypassed the
  script, and the fix is to re-run `mise run redeploy-uat`, which pins both
  deployments to one digest and rolls them atomically. `kubectl rollout restart
  deploy/web-client -n fortymm-uat` also converges them, but onto whatever the
  tag resolves to *now*, so it treats the symptom and leaves the cause.
  **[destructive/shared]** — a rollout restart on shared UAT is the user's call.

### `redeploy-uat` won't deploy: "no image published for … after 2400s"

- **Symptom:** The script prints `ghcr.io/mightymoose/fortymm-<pkg>:<12-char
  sha> not published yet — waiting up to 2400s`, then eventually
  `ERROR: no image published for … after 2400s` and exits without deploying.
- **Cause:** `publish.yml` has not produced images for the commit at
  HEAD (after the script's `git merge origin/main`). Either the run is still
  going (~25 min, emulated arm64), or it failed for that commit, or HEAD is not
  a commit that exists on `origin/main` — only pushed `main` commits are ever
  published.
- **Fix:** check the workflow runs, then re-run the script. It deliberately does
  **not** fall back to an older commit's images: silently running something other
  than the commit you asked for is the failure mode this path exists to remove.
  `DIGEST_WAIT_TIMEOUT_S=0` turns the wait into an immediate failure when you
  only want to know whether images exist.
- **Not this:** `ERROR: anonymous pull DENIED for ghcr.io/…` is the *other*
  registry failure — a package that is still private (or does not exist yet),
  fixed by the one-time visibility flip above, not by waiting.

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
  schema, then re-deploy to re-fire the post-upgrade migrate+seed hook Job:
  ```bash
  kubectl scale deploy/api deploy/worker --replicas=0 -n fortymm-uat
  # psql into the postgres pod, then:  DROP SCHEMA public CASCADE; CREATE SCHEMA public;
  mise run redeploy-uat       # re-runs the migrate Job against the empty schema
  ```
  **[destructive/shared]** — `DROP SCHEMA` wipes all UAT data; confirm with the
  user before running it.
  Re-deploy through the script, not a bare `helm upgrade`: an upgrade with no
  `--set images.*.digest=` resets those values to the chart's empty defaults and
  drops the whole release back onto the moving `:main` tag — the blank-page entry
  above. (`--reuse-values` keeps them, but the script is the fewer-footguns path.)

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
5. On k3d UAT, both `web-client` pods share **one `imageID`** (no digest drift).
   Digest pinning makes this true by construction, so the check is now a check
   *that the deploy went through the script*: a bare `helm upgrade` falls back to
   the moving `:main` tag, where drift is possible again. Confirm the pod
   template names `…@sha256:…`, not `…:main`.

## Note on host-specific details

The exact router/DDNS/Caddy chain and secret *values* live in the **operator's
environment**, not in any checked-in file. `## Topology` above documents the
repo-general shape (chart, stacks, ports, mail routing); don't hardcode
host-specific wiring or credentials into it.
