# UAT deploys published images, pinned by digest

Until now `scripts/redeploy-uat.sh` built `api/Dockerfile.dev` and
`web-client/Dockerfile.uat` on the operator's own machine and `k3d image
import`ed them straight into the cluster, so the artifact UAT ran existed
nowhere else and had never been through CI. As the first step toward a Hetzner
production deploy (issue #1255), CI now builds those same two Dockerfiles once
per commit on `main` and pushes them to `ghcr.io/mightymoose/fortymm-api` and
`ghcr.io/mightymoose/fortymm-web-client`; UAT — and, later, prod — pulls the
published image rather than building its own. **`redeploy-uat.sh` no longer
builds anything**, and there is no `--local` escape hatch back to an
unvalidated image: the script already refused to deploy from any branch but
`main`, so the local build could never produce anything that wasn't already on
`main` anyway, and keeping the path alive would only preserve the failure mode
this change exists to remove.

## The pod template names a digest, not a tag

The publish workflow tags each image `<git-short-sha>` (plus a moving `main`),
but the chart deploys `repository@sha256:…`: `redeploy-uat.sh` resolves the tag
to its manifest-list digest at deploy time and passes
`--set images.{api,web}.digest=`.

This supersedes the `$(git rev-parse --short HEAD)-$(date +%s)` tag scheme, and
the reasoning is worth keeping because the old scheme's rationale no longer
applies. That epoch suffix existed to force a *new* image string on every
deploy, because a local rebuild could produce different content under the same
commit, and an unchanged pod template plus `pullPolicy: IfNotPresent` meant
`helm upgrade` would leave both replicas on stale code — the incident recorded
in `deploy/CLAUDE.md` as "UAT redeploy lands stale code — blank white page",
where two `web-client` replicas served two different content-hashed bundles
behind a round-robin nginx and ~half of page loads 404'd their JS chunk.

A digest is content-addressed, so the guarantee stops being a convention and
becomes structural: two replicas naming the same digest **cannot** be running
different content, and re-running the publish workflow for an
already-published commit cannot silently change what UAT is running the way
overwriting a `:<short-sha>` tag would. It also makes a same-commit redeploy a
correct no-op rather than a pointless roll of both replicas — which is now the
desired behaviour, since byte-identical content has nothing to roll to.

## Images are multi-arch; packages are public

Both images are built for `linux/amd64` **and** `linux/arm64` via buildx, and
published as a manifest list. UAT's k3d cluster runs on the operator's machine
rather than a runner, so an amd64-only image would either fail to run there or
run under emulation; the arm64 leg costs real CI time (it is QEMU-emulated on
the amd64 runner) and is paid deliberately so that one published artifact
serves both the operator's cluster today and an amd64 Hetzner box later,
without a second decision.

The packages are **public**, so nothing downstream needs credentials and the
chart carries no `imagePullSecrets`. GHCR publishes packages **private on first
push even from a public repository**, so this requires a one-time manual
visibility flip per package after the first successful run; `redeploy-uat.sh`
preflights anonymous pullability and fails with the exact click-path rather
than letting the deploy die as an `ErrImagePull` five minutes into `helm
--wait`.

## Consequences

- **Deploying UAT now depends on CI.** A merge is not deployable until the
  publish workflow finishes (~20–30 min, dominated by the emulated arm64 leg).
  `redeploy-uat.sh` waits for the digest with a bounded timeout and then exits
  non-zero naming the commit and the workflow run, rather than deploying
  something older without saying so.
- **`VITE_*` build args are fixed at publish time.** `web-client/Dockerfile.uat`
  bakes `VITE_FARO_COLLECTOR_URL` and `VITE_GOOGLE_MAPS_API_KEY` into the
  bundle, and the operator's `.env` is no longer in that loop. Faro's collector
  is a same-origin path (`/faro/collect`) and is passed unconditionally; the
  Maps key becomes a repository secret. It is a *browser* key — readable in the
  shipped bundle either way — so this moves where it is stored, not how exposed
  it is, but its Google-console referrer restrictions must now cover every
  origin that will serve this one bundle.
- **`api/Dockerfile.dev` is still the published API image**, unchanged and
  deliberately out of scope here. Its `--reload` CMD is already overridden by
  the chart's explicit `command:`, so the only real cost is that `.[dev]` test
  dependencies ship in the image. Slimming or renaming it belongs with the
  Hetzner production work, not with this groundwork.
