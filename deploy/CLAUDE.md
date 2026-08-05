# CLAUDE.md — infra / deploy runbook

Operational runbook for the fortymm infra surface, and the source of truth for
the deploy topology — the `fortymm` k3d/Helm chart UAT runs, the QA/dev compose stacks,
Mailpit, the port map, `redeploy-uat.sh`, and the tailnet. The root `CLAUDE.md`
carries only the one-table summary. `## Topology` below is the detail;
`## Operational failure modes` is what bites in practice.

**The operator** is whoever runs the machine hosting UAT — its host
Caddy/DDNS/tailnet config and secret values live there, not in this repo.

## The surface

Infra has no single directory — it spans:

- `deploy/fortymm/` — Helm chart for the fortymm stack: postgres, redis, api ×2,
  worker, web-client ×2, routing nginx, optional tailscale proxy. Migrate+seed
  runs as a `post-install,post-upgrade` hook Job, the retirement sweep as a
  CronJob. **The chart names no environment.** Hostnames, Secret names, storage
  class and worker sizing are values, and the chart's own defaults are neutral.
  UAT is one environment that runs it. The api and web images are **pulled from
  GHCR and pinned by digest** — nothing in this chart is built locally. See
  `docs/adr/20260805-the-stack-chart-is-environment-neutral-and-named-fortymm.md`.
- `deploy/environments/` — one values file per environment: `uat.yaml` for the
  stack chart, `uat-observability.yaml` for the observability chart.
  `redeploy-uat.sh` passes each with `-f`. They live **outside** both charts on
  purpose, so `helm package` cannot put one environment's hostnames inside a
  published artifact. The cost is that a UAT deploy still needs this repo checked
  out for its values.
- `deploy/observability/` — umbrella chart (kube-prometheus-stack + loki-stack
  + tempo) in the `monitoring` namespace, tailnet-only.
- `docker-compose.{dev,qa,e2e}.yml` — the compose stacks. There is **no**
  `docker-compose.uat.yml`: UAT is k3d/Helm only (the chart above).
- `nginx/` — `dev.conf` (web upstream :5173) and `uat.conf` (web upstream :80);
  `uat.conf` is mounted by the QA compose stack. The k8s routing nginx does NOT
  read this file — it renders an **inline copy** in
  `deploy/fortymm/templates/_helpers.tpl` (`fortymm.nginxConf`, which also adds a
  `/faro/` block). When you touch `uat.conf`, update the helper copy too.
- `.github/workflows/*.yml` — CI (api, web-client, e2e, openapi-schema, ios, …),
  including **`publish.yml`**, which pushes the api/web images **and both Helm
  charts** to GHCR on every push to `main` (see `## Published images (GHCR)` and
  `## Published charts (GHCR)`).
- `mise.toml` — toolchain pins (node, python, `helm`, `k3d`) + task runner:
  `redeploy-uat` (deploy the published, digest-pinned chart to k3d), `qa-down`,
  `regen-*-types`, `ios-testflight`, and `release-beta` (UAT then TestFlight).

## Stacks at a glance

| Stack | How | Host URL | Notes |
|-------|-----|----------|-------|
| dev   | `docker compose -f docker-compose.dev.yml up` | :8080 | dev servers, MSW off; real API |
| QA    | up `scripts/qa-up.sh [id]` / down `scripts/qa-down.sh [id]` | :8085 (auto) | built artifacts, MSW off, **Mailpit :8087** captures all mail; multi-stack; **reap on merge** |
| UAT   | `mise run redeploy-uat` | host :8084 → NodePort 30084 | **k3d/Helm — the one prod-like stack NOT on compose**; installs the **CI-published chart**, which carries digest-pinned GHCR images (builds nothing, so a merge isn't deployable until `publish` finishes); sends REAL Postmark email |

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

**UAT consumes these images, through the chart.** The deploy script no longer
looks a tag up. The same workflow's chart job reads each image job's push digest
and writes it into the chart's values before packaging, so the pods name
`repository@sha256:…` because the published chart says so (see
`## Published charts (GHCR)` and `## Topology`). The practical consequence is
unchanged: **a merge is not deployable until this workflow has finished for it**.
The deploy script waits for the chart rather than quietly deploying an older
commit, and the chart job runs after these image jobs.

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
`redeploy-uat.sh` preflights the same thing on every deploy, one level up: its
anonymous `helm pull` of the chart proves the registry answers strangers. It
prints the click-path as the secondary cause when that pull never resolves.

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

## Published charts (GHCR)

The same `.github/workflows/publish.yml` packages both Helm charts and pushes
them to GHCR as OCI artifacts. Installing or reading a chart needs `helm` and no
checkout. A **UAT** deploy still needs this checkout for two things a published
chart cannot carry: `scripts/redeploy-uat.sh` and `deploy/environments/uat.yaml`.

- `ghcr.io/mightymoose/fortymm/charts/fortymm`, the **stack chart**, packaged
  from `deploy/fortymm/`
- `ghcr.io/mightymoose/fortymm/charts/observability`, the **observability
  chart**, packaged from `deploy/observability/`

`helm push` appends the chart name to the repository path, so each path ends in
that chart's `name:` from `Chart.yaml`. The stack chart is named `fortymm`, not
`fortymm-uat`, because the package name is a public fact and UAT is only one
environment that runs it.

**The chart version is `0.1.0-sha<12-char sha>`, and the `sha` prefix is
load-bearing.** Helm validates the version as SemVer, and the bare 12-char
truncation the images use as a tag is not a version at all. `helm package
--version b17a29fa1234` fails with `Error: invalid semantic version`. So the
SHA has to be encoded into a SemVer string, and the obvious encoding carries
its own trap. SemVer forbids a leading zero in a *numeric* pre-release
identifier, so the tidier-looking
`0.1.0-<sha>` is rejected whenever the truncation is all digits starting with
0. `helm package --version 0.1.0-000123456789` fails with
`Error: version segment starts with 0`. That is roughly one commit in three
thousand, and it fails **in CI, at publish time, on a commit that is otherwise
perfectly good**. Gluing `sha` to the front makes the identifier alphanumeric
and therefore always legal. **Do not tidy the prefix away.**

**Both `Chart.yaml` files keep `version: 0.1.0` and `appVersion: "0.0.0-dev"` in
the repo.** CI stamps the real version and the deploying commit at package time
(`helm package --version --app-version`). So no commit has to bump a chart file,
and the version cannot drift from the commit it was built from. A `0.0.0-dev`
`appVersion` in `helm show chart` output means you are reading a chart rendered
straight from a checkout, not a published one.

**The stack chart carries its own image digests.** CI rewrites
`images.api.digest` and `images.web.digest` into the chart's values before
packaging, using the digests the two image jobs report from their own push
steps. A published chart is therefore a complete description of one commit's
stack. The chart version is the **single coordinate** an install or a rollback
names. Chart and images cannot drift apart, because CI welded them together at
publish time:

```bash
helm upgrade --install fortymm-uat \
  oci://ghcr.io/mightymoose/fortymm/charts/fortymm \
  --version "0.1.0-sha$(git rev-parse HEAD | cut -c1-12)" \
  --namespace fortymm-uat --create-namespace \
  -f deploy/environments/uat.yaml
```

**The `-f` is not optional.** The chart is environment-neutral, so an install
without UAT's values file renders neutral defaults and produces a stack that is
not UAT (see `## Operational failure modes`). This command is written out so you
can read what the deploy does. Use `mise run redeploy-uat` to actually deploy —
it also resolves the version to a digest and syncs the Secrets.

Rollback is the same command naming an older version, and the older chart
brings its matching image digests with it. Secrets stay out of band: the
`fortymm-uat-env` and `-apns` Secrets come from the operator's `.env`, and no
published artifact can carry them.

**The published chart is not byte-identical to `deploy/fortymm/` in the repo.**
CI rewrites the two digest values before packaging. `helm package` then stamps
`version` and `appVersion` into the packaged `Chart.yaml` and reserializes it,
so key order, comments and line wrapping all change too. Expect those
differences when you diff the published chart against the repo. CI reads the
digests back out of the packaged file and refuses to push unless it finds two,
because an *empty* digest is not malformed to the chart. The chart treats it as
the documented render fallback and renders the moving `:main` tag, which is the
blank-white-page failure mode below.

**Charts get no moving `main` tag.** Helm derives the OCI tag from the chart
version, so exactly one tag exists per commit. A second tag would mean
packaging twice or reaching for `oras`, and nothing would consume it: an
outside deployer wants a pinned version, not a moving one. The images keep
`:main` only because `values.yaml` uses it as the render fallback.

**No credentials needed to pull.** A package pushed by `GITHUB_TOKEN` with
`packages: write` is linked to the publishing repository and inherits its
visibility, and this repo is public. That mechanism was verified for the two
images (see the visibility subsection above), so the charts are public by the
same route. No chart carries `imagePullSecrets`.

**The observability chart resolves dependencies with `helm dependency build`,
never `update`.** `deploy/observability/charts/` is **gitignored** and only
`Chart.lock` is committed, so a runner starts with no subcharts on disk. CI
therefore has to `helm repo add` both `prometheus-community` and `grafana`
first, or the next command cannot find the repositories. `build` resolves from
the committed `Chart.lock`, so the published chart vendors exactly the subchart
versions this repo has run in UAT. `update` re-resolves against the upstream
repositories and could pull newer than the lock, which would make a tagged,
immutable chart depend on the day CI ran. The published package carries the
expanded subcharts inside it, and that is what takes the upstream fetch off the
**deploy** path. CI checks the packaged tarball for all three subchart
`Chart.yaml` files and refuses to push if any is missing. `redeploy-uat.sh` runs
neither `helm repo add` nor `helm dependency build` any more. A deploy reaches
`ghcr.io` and nothing else.

**The observability chart does not wait on the image builds.** It bakes no
fortymm digests, so it needs only the tag job. The stack chart `needs` both
image jobs for their digests, so it inherits their **~25-minute critical
path**.

**The chart jobs cannot be proven from a pull request.** `publish.yml` runs on
push to `main` only, so no chart package can exist until the change merges. The
first real evidence is the run after merge.

## Topology

**UAT runs on Kubernetes (Helm + k3d).** UAT is the one prod-like stack that does *not* use docker-compose. `scripts/redeploy-uat.sh` (a.k.a. `mise run redeploy-uat`) **builds nothing and packages nothing** — it installs the chart CI already published for the commit being deployed. It refuses any branch but `main` (or the legacy `uat-deploy` worktree), merges `origin/main` into it first so the deploy names the newest main, and provisions a single-node **k3d** cluster `fortymm-uat`. It then derives the chart version `0.1.0-sha<12-char sha>` from HEAD, `helm pull`s `oci://ghcr.io/mightymoose/fortymm/charts/fortymm` at that version, and reads the **OCI digest** helm reports for what it pulled. It syncs Secrets from the gitignored `.env` + `secrets/*.p8`, then `helm upgrade --install`s the chart **by digest** with `-f deploy/environments/uat.yaml` (`--wait --timeout 5m`). The observability release follows the same shape with `deploy/environments/uat-observability.yaml`. Routing nginx is a **NodePort** (30084); k3d maps host **:8084** → that NodePort, so host Caddy (still pointing at `127.0.0.1:8084`) fronts uat.fortymm.com unchanged. Migrations + seeds run as a `post-install,post-upgrade` Helm hook **Job** (not in the api boot command). Needs `helm` + `k3d` (`brew install helm k3d`). Inspect with `KUBECONFIG=$(k3d kubeconfig write fortymm-uat) kubectl get pods -n fortymm-uat`.

**The script no longer resolves image digests.** It used to mint a GHCR token and walk the v2 manifest API for each package, then pass `--set images.api.digest=… --set images.web.digest=…`. CI now bakes both digests into the chart's values at package time, so the chart version is the **single coordinate** the deploy names and the pods get their digests from the artifact. The script reimplements no registry client. See `docs/adr/20260805-charts-publish-to-ghcr-versioned-by-commit-with-image-digests-baked-in.md`.

**Why the deploy names a digest and not a version.** Two digests are in play and they are different things. The **chart** digest is what `helm pull` reports, and the script installs by it so the bytes deployed are the bytes that resolve answered with, whatever happens to a tag afterwards. The **image** digests ride inside those bytes: `fortymm.imageRef` in `_helpers.tpl` renders `repository@sha256:…` whenever a digest is set, and every workload that runs app code (api, worker, migrate Job, retirement CronJob, web-client) goes through it. A digest is content-addressed, so "every replica runs the same bytes" stops being a convention and becomes structural — two pods naming one digest *cannot* be running different content. Empty `digest` in `values.yaml` falls back to `repository:tag` (the moving `:main`) purely so `helm template deploy/fortymm` renders on its own; every *published* chart carries two real digests, because CI reads them back out of the package and refuses to push otherwise. A set-but-malformed digest fails the render rather than being tolerated. The old `$(short-sha)-$(epoch)` unique-tag scheme is gone and should not come back — it existed because a *local* rebuild could produce different content under one commit, so the pod template had to change to force a roll. Published charts and images are immutable, so a same-commit redeploy is a correct no-op. See `docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md`.

**Deploying depends on CI.** The chart for a commit exists only once `publish.yml` has finished for it (~25 min, dominated by the emulated arm64 image leg), so a just-merged commit is not immediately deployable. The chart job runs after the image jobs, so waiting for the chart implicitly waits for the images. The script retries the `helm pull` every 30s for up to `DIGEST_WAIT_TIMEOUT_S` (default `2400`, i.e. 40 min) and then fails naming the commit and linking the workflow runs, rather than deploying an older commit without saying so. `DIGEST_WAIT_TIMEOUT_S=0` fails immediately instead of waiting. Only a registry answer of `not found` / `denied` / `unauthorized` / `manifest unknown` is worth waiting on. A DNS, TLS or proxy error fails at once with helm's own words, because it will not fix itself in 40 minutes. The anonymous pull doubles as the pullability preflight: if it resolves, the cluster can pull the same artifact, which is why no chart carries `imagePullSecrets`.

**The checkout is still needed, for two things.** A published chart cannot carry the deploy script, and it cannot carry `deploy/environments/`. Everything that makes a deploy *UAT* — hostnames, the Auth0/MCP identifiers, the Secret names, the tailnet node name, the storage class, the worker's 16-core solver sizing — lives in that values file. The script checks both files exist **before** the wait, not after it, so a missing one fails in a second rather than 40 minutes later.

**UAT is also on the tailnet.** The chart runs a `tailscale/tailscale` proxy (`deploy/fortymm/templates/tailscale.yaml`, `tailscale.enabled` in values, on by default) that fronts the routing nginx via `tailscale serve`, so UAT is reachable privately at **`https://fortymm-uat.<tailnet>.ts.net`** with auto-HTTPS — independent of the DDNS/router/Caddy chain (which still serves `uat.fortymm.com` unchanged; Tailscale is purely additive). It reads `TS_AUTHKEY` (a reusable, non-ephemeral key from the Tailscale admin console) straight from the `.env`-backed secret, so just add a `TS_AUTHKEY=tskey-...` line to `.env`; `redeploy-uat.sh` errors early if it's missing. The proxy persists its node identity in the `tailscale-state` Secret (survives restarts; no re-auth). Requires HTTPS certs + MagicDNS enabled in the tailnet. Set `tailscale.enabled=false` to skip it. The node name is a value: `deploy/environments/uat.yaml` sets `tailscale.hostname: fortymm-uat`, and the chart's neutral default is `fortymm`. Changing it makes Tailscale register a **new** node rather than rename the old one, so leave it alone unless you mean to.

Prod-like compose stacks (built artifacts, no dev server, isolated volumes; only nginx published):
- `docker compose -f docker-compose.qa.yml up -d --build` — `fortymm-qa`, nginx on **:8085**, local-only at http://127.0.0.1:8085. Same app shape as UAT, separate project/port/volumes. Tear down with **`scripts/qa-down.sh [id]`**, not `down -v` — the latter leaves the stack's built images and buildx cache behind (that leak once grew `Docker.raw` to 230 GB and wedged the daemon). To run **multiple QA stacks at once**, parameterize per stack: `QA_ID=<id> QA_PORT=<port> QA_MAILPIT_PORT=<port>` override the project name, nginx host port (+`APP_BASE_URL`), and Mailpit port. `scripts/qa-up.sh [id]` picks a free port trio automatically and prints the assigned URL.

**Preview-stack email.** The **QA** stack runs a `mailpit` service that captures *all* outbound email instead of relaying it through the real Postmark account in `.env`. Its api/worker `environment:` blocks override `SMTP_*` (`SMTP_HOST=mailpit`, `:1025`, no TLS, blank creds) so it can never send real mail — the worker's RQ `email` jobs (confirmation / magic-link sign-in / account-merge, see `api/app/email.py`) land in Mailpit. Read them at the Mailpit web UI: **QA → http://127.0.0.1:8087** (host-local only; not proxied by Caddy, since captured mail contains live sign-in links). QA also overrides `APP_BASE_URL` to `http://127.0.0.1:8085` so captured links are clickable. To verify a sign-in/confirmation flow on QA, trigger it in the UI then open the Mailpit UI to grab the link.

**UAT sends real email.** Unlike QA, the UAT stack does *not* run Mailpit — it relays through the live Postmark account configured by `SMTP_*` in `.env`. Mail triggered on UAT lands in real inboxes.

## Common commands

```bash
mise run redeploy-uat                 # install this commit's published chart (digest-pinned) onto k3d; smoke-check uat.fortymm.com
DEPLOY_OBSERVABILITY=false mise run redeploy-uat   # skip the monitoring chart
DIGEST_WAIT_TIMEOUT_S=0 mise run redeploy-uat      # don't wait on publish; fail now if this commit has no chart
scripts/qa-up.sh [id]                 # bring up an isolated QA stack on a free port trio; prints QA_URL / Mailpit URL
scripts/qa-down.sh [id]               # reap that stack: containers, volumes (named + anonymous), networks, built images
scripts/qa-down.sh --dry-run [id]     # preview what would be removed
scripts/qa-down.sh --all              # every fortymm-qa-* stack (k3d/UAT resources are guarded)
scripts/qa-down.sh --all --prune-cache  # ...plus the GLOBAL buildx cache (opt-in; next build is cold everywhere)

# Inspect UAT (point kubectl/helm at the k3d cluster first):
export KUBECONFIG="$(k3d kubeconfig write fortymm-uat)"
kubectl get pods -n fortymm-uat
kubectl logs -n fortymm-uat deploy/api --tail=40
helm list -n fortymm-uat              # which chart VERSION is deployed -> which commit
kubectl get pods -n monitoring        # observability

# Read the published chart without a checkout:
helm show chart oci://ghcr.io/mightymoose/fortymm/charts/fortymm --version 0.1.0-sha<sha>
helm show values oci://ghcr.io/mightymoose/fortymm/charts/fortymm --version 0.1.0-sha<sha>
```

## Operational failure modes

Each is symptom → cause → fix. Fixes marked **[destructive/shared]** mutate a
shared local cluster or stack — **flag them for the user; do not run them
unprompted.**

### `spec.selector: field is immutable` — the one-time chart-rename migration

**This is a migration, not a recurring operation.** It applies once, to the
release that was installed before the chart was renamed `fortymm`. Do not run it
routinely, and do not reach for it when a normal deploy fails.

- **Symptom:** `helm upgrade` fails outright and rolls nothing:
  ```
  The Deployment "api" is invalid: spec.selector: Invalid value:
  {"matchLabels":{…,"app.kubernetes.io/name":"fortymm"}}: field is immutable
  ```
  Confirmed against the live cluster by a server-side dry run, not predicted.
- **Cause:** `app.kubernetes.io/name` changed from `fortymm-uat` to `fortymm`
  with the chart rename. The `fortymm.selector` helper renders that label into
  `spec.selector.matchLabels`, and Kubernetes makes that field immutable after
  creation.
- **A partly-applied upgrade takes UAT dark.** Helm applies Services before
  Deployments. A Service's `spec.selector` is mutable, so the Services flip to
  `app.kubernetes.io/name: fortymm` and then the Deployments fail. The old pods
  still carry `fortymm-uat`, so every Service now selects nothing and UAT serves
  nothing until the Deployments are recreated.
- **Do NOT `helm uninstall`.** No resource in the chart carries
  `helm.sh/resource-policy: keep`, so uninstalling deletes the `postgres-data`
  PVC and wipes UAT's database. Only the **Deployments** carry the immutable
  field, so deleting just those is enough:
  ```bash
  export KUBECONFIG="$(k3d kubeconfig write fortymm-uat)"
  kubectl delete deploy api web-client worker nginx postgres redis tailscale \
    -n fortymm-uat --ignore-not-found
  mise run redeploy-uat
  ```
  `--ignore-not-found` is there because `tailscale` renders only under
  `tailscale.enabled`, so a cluster without it would otherwise print an error
  that reads like the migration failed. **Re-deploy through the script**, not
  through the bare `helm upgrade` that produced the error — a bare upgrade drops
  `-f deploy/environments/uat.yaml` and hands you the next entry's problem on top
  of this one. Helm recreates the Deployments with the new selector. The release
  history, the `postgres-data` PVC and the `tailscale-state` Secret all survive,
  so the data is not wiped and the tailnet identity is not at risk. UAT is down
  for the minute or two the recreate takes.
  **[destructive/shared]** — deleting Deployments on shared UAT is the user's
  call. Confirm the `tailscale-state` Secret is still present before and after
  (`kubectl get secret tailscale-state -n fortymm-uat`): losing it is what
  produces the `fortymm-uat-1` node rename.
- **Why the label was not left at `fortymm-uat`.** That would put the environment
  back into the label the rename exists to take it out of. See
  `docs/adr/20260805-the-stack-chart-is-environment-neutral-and-named-fortymm.md`.

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
  (`fortymm.imageRef`), and a digest is content-addressed: two replicas
  naming one digest cannot be running different bytes, whenever either of them
  was scheduled. That also retires the `$(short-sha)-$(epoch)` tag scheme that
  used to be the countermeasure — see `## Topology`.
- **What can still produce it:**
  1. **A deploy that rendered the working tree instead of a published chart.**
     `images.*.digest` is empty in `deploy/fortymm/values.yaml` by design, and
     with it empty the chart renders `repository:main` — a tag that moves on
     every push to `main`. Under `IfNotPresent` each pod resolves that string
     only when it actually pulls, so a pod created before a merge and its
     replacement created after one sit on different images with an identical pod
     template, and Helm rolls nothing. This is the old failure mode wearing a new
     tag. Reached by `helm install … deploy/fortymm` from a checkout, or by
     `helm template deploy/fortymm` piped into `kubectl apply`. A **published**
     chart cannot do this: CI rewrites both digests at package time, reads them
     back out of the tarball, and refuses to push unless it finds two. So the
     rule is narrower than it used to be but no weaker — **deploy the published
     chart, never the directory.**
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
  — a `…:main` there rather than `…@sha256:…` means the deploy rendered a
  checkout instead of a published chart, and the fix is to re-run
  `mise run redeploy-uat`, which pins both deployments to one digest and rolls
  them atomically. `kubectl rollout restart
  deploy/web-client -n fortymm-uat` also converges them, but onto whatever the
  tag resolves to *now*, so it treats the symptom and leaves the cause.
  **[destructive/shared]** — a rollout restart on shared UAT is the user's call.

### `redeploy-uat` won't deploy: "no chart published at … after 2400s"

- **Symptom:** The script prints
  `oci://ghcr.io/mightymoose/fortymm/charts/fortymm:0.1.0-sha<sha> not published
  yet — waiting up to 2400s`, then eventually `ERROR: no chart published at …
  after 2400s` and exits without deploying.
- **Cause:** `publish.yml` has not produced a chart for the commit at HEAD (after
  the script's `git merge origin/main`). Either the run is still going (~25 min,
  because the chart job waits on the emulated-arm64 image jobs), or it failed for
  that commit, or HEAD is not a commit that exists on `origin/main` — only pushed
  `main` commits are ever published.
- **Fix:** check the workflow runs, then re-run the script. It deliberately does
  **not** fall back to an older commit's chart: silently running something other
  than the commit you asked for is the failure mode this path exists to remove.
  `DIGEST_WAIT_TIMEOUT_S=0` turns the wait into an immediate failure when you
  only want to know whether a chart exists.
- **Why "denied" is not read as "private".** GHCR answers an anonymous token
  request the same way — 403 `denied` — for a package that is private and for one
  no publish has ever created. So the script cannot tell the two apart while a
  run may still be in flight, and it treats `denied` as "keep waiting". The
  visibility click-path prints only as a **secondary** cause once the wait times
  out. If the run for the commit did succeed, check that nobody changed the
  package's visibility by hand (see `## Published images (GHCR)` — nothing needed
  flipping on the first publish, so a private package means someone changed it).
- **Not this:** a DNS, TLS or proxy error fails immediately with helm's own words
  instead of waiting. Those do not fix themselves in 40 minutes.

### UAT DB keeps the OLD schema — every endpoint on a changed table 500s

- **Symptom:** New code is live but every authed BFF endpoint touching a changed
  table returns 500; the served `openapi.json` has the new paths but the DB is
  missing the new columns.
- **Cause:** Migrations are edited **in place** with frozen revision ids
  (fortymm is undeployed — see the pre-deploy migration convention), but UAT's
  Postgres runs on a **persisted PVC** (`deploy/fortymm/templates/postgres.yaml`,
  5Gi; the chart defaults the storage class to empty and `uat.yaml` names k3d's
  `local-path`). The
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
  Re-deploy through the script, not a bare `helm upgrade`. See the next entry for
  what a bare upgrade costs now.

### A `helm upgrade` without `-f deploy/environments/uat.yaml` un-UATs the release

- **Symptom:** Helm reports success and the stack comes up wrong. The loudest
  sign is api pods stuck in `CreateContainerConfigError`. Fix only that and the
  quieter ones remain: MCP 401s on every request, a second tailnet node, a worker
  with 2 cores instead of 16.
- **Cause:** The chart is environment-neutral, so **every** UAT-specific value
  lives in `deploy/environments/uat.yaml`. Helm does not remember a values file
  between upgrades. An upgrade that omits `-f` renders the chart's neutral
  defaults over the whole release, one field at a time:
  - `secrets.env` / `secrets.apns` fall back to `fortymm-env` / `fortymm-apns`,
    which do not exist in this cluster. The `secretRef` in `fortymm.appEnvFrom`
    is **not** optional, so the api, worker and migrate Job cannot start.
  - `config.AUTH0_*` and `config.MCP_*` go empty, which is "MCP auth
    unconfigured" — the api boots and every MCP request 401s.
  - `tailscale.hostname` falls back to `fortymm`. Tailscale registers that as a
    **new** node rather than renaming the old one, so
    `fortymm-uat.<tailnet>.ts.net` stops answering.
  - `postgres.storageClass` goes empty and `worker.cpu` drops from 16 to 2.
- **This replaced the old footgun, it did not remove it.** A bare upgrade used to
  reset `images.*.digest` and drop the release onto the moving `:main` tag. The
  digests now ride inside the published chart, so that specific loss is gone and
  the values file took its place. Same rule, different reason.
- **Fix:** re-run `mise run redeploy-uat`, which always passes `-f`. If you must
  drive helm by hand, pass the values file.
- **`--reuse-values` is not the shortcut it looks like.** It reuses the previous
  release's merged values, and it also ignores the *new chart's* changed
  defaults. This rename changed several of them (`postgres.storageClass`, the
  worker sizing, `tailscale.hostname`, the Faro CORS list). So it hides the
  missing `-f` for the values that happen to carry over, while pinning the
  release to defaults the chart no longer ships. Pass `-f`.

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
   *that the deploy installed a published chart*: rendering `deploy/fortymm/`
   from a checkout falls back to the moving `:main` tag, where drift is possible
   again. Confirm the pod template names `…@sha256:…`, not `…:main`.
6. On k3d UAT, the deployed **chart version names the commit you meant**.
   `helm list -n fortymm-uat` prints it, and `0.1.0-sha<12-char sha>` decodes
   straight back to the commit. This is the cheapest provenance check the stack
   has: one coordinate covers the chart and both image digests, because CI welded
   them together at publish time.
7. On k3d UAT, the release still has UAT's values. `helm get values fortymm-uat
   -n fortymm-uat` must show `secrets.env: fortymm-uat-env` and
   `tailscale.hostname: fortymm-uat`. Neutral defaults there mean the upgrade
   dropped `-f deploy/environments/uat.yaml`.

## Note on host-specific details

The exact router/DDNS/Caddy chain and secret *values* live in the **operator's
environment**, not in any checked-in file. `## Topology` above documents the
repo-general shape (chart, stacks, ports, mail routing); don't hardcode
host-specific wiring or credentials into it.
