# Charts publish to GHCR, versioned by commit, with image digests baked in

`docs/adr/20260802-uat-deploys-published-images-pinned-by-digest.md` moved the
api and web *images* out of the operator's laptop and into GHCR, so a deploy
pulls an artifact CI built. The **chart** never made that move. `helm upgrade`
still pointed at `deploy/uat/` in a git checkout, so deploying required cloning
this repo, and `scripts/redeploy-uat.sh` had to resolve both image digests from
the GHCR API itself before it could render anything.

CI now packages both charts and pushes them to
`ghcr.io/mightymoose/fortymm/charts/{fortymm,observability}`. The goal is that
anyone can deploy fortymm from any machine with `helm` and no checkout.

## The chart version encodes the commit, because a bare SHA is not a version

Helm validates `Chart.yaml`'s `version` as SemVer, so the 12-character commit
truncation the images use as a tag is rejected outright:
`chart.metadata.version "b17a29fa1234" is invalid`. The SHA has to be *encoded*
into a SemVer string, and the obvious encodings are not equally safe.

We publish **`0.1.0-sha<12-char-sha>`** — the `sha` prefix is load-bearing.
SemVer forbids a leading zero in a *numeric* pre-release identifier, so the
tidier-looking `0.1.0-<sha>` fails whenever a commit's truncated SHA happens to
be all digits with a leading zero. That is roughly one commit in three
thousand, and it would fail **in CI, at publish time, on a commit that is
otherwise perfectly good** — a rare, unreproducible break landing on whoever
merged next. Gluing `sha` to the front makes the identifier alphanumeric and
therefore always legal, whatever the SHA turns out to be. This is the same
class of trap the images ADR recorded about `git rev-parse --short`, and it is
written down here for the same reason: it is invisible until it bites.

The rejected alternative is SemVer *build metadata*, `0.1.0+<sha>`, which is
also always legal. It loses on ergonomics. `+` is not a valid character in an
OCI tag, so Helm rewrites it to `_` on push and back on pull, and prints a
four-line explanation of that convention on **every push and every pull**. For
a chart whose entire purpose is being pulled by people who did not write it,
that is a permanent wart on the first thing they see.

**`Chart.yaml` keeps `version: 0.1.0` in the repo.** CI stamps the real version
with `helm package --version`, so no commit ever has to bump a chart file and
the version cannot drift from the commit it was built from.

## The published chart carries its own image digests

CI rewrites `images.{api,web}.digest` into the chart's values at package time,
using the manifest digests that the image jobs' own push steps report. A
published chart is therefore a complete, coherent description of one commit's
stack, and this is the property the whole change turns on.

Before, a deploy was three coordinates — chart at commit X, api digest at
commit X, web digest at commit X — held together *only* by the fact that one
git checkout produced all three. Publishing the chart separately would have
dissolved that guarantee silently: nothing structural stops someone pulling
chart `sha-ABC` and pointing it at images from `sha-XYZ`, and the result would
be a stack that renders, deploys, and is subtly wrong.

Baking the digests in replaces that lost guarantee with a stronger one. The
chart version becomes the **single** coordinate:

```bash
helm upgrade --install fortymm \
  oci://ghcr.io/mightymoose/fortymm/charts/fortymm --version 0.1.0-sha<commit>
```

Rollback is the same command naming an older version, and the older chart
brings its own matching image digests with it — chart and images cannot drift
apart because they were welded together at publish time. This does not replace
`helm rollback <revision>`, which stays the quickest way to undo the last
deploy and needs no registry at all.

The cost is that the published chart is **not byte-identical to `deploy/fortymm/`
in the repo**. CI rewrites the two digest values before packaging, and
`helm package` then stamps the version and appVersion and reserializes
`Chart.yaml` — which reorders keys, drops comments and reflows the description.
So a diff between the repo and a published chart is expected to be noisy, and
"the values differ" is the wrong thing to read it for. The claim worth checking
is narrower: the published `images.{api,web}.digest` are the digests that
commit's images actually published.

## Publishing is one job in one workflow

`publish-images.yml` is renamed `publish.yml`, and the charts are a job in it
rather than a workflow of their own. The chart job `needs` the two image jobs,
which buys three things a separate workflow would have to rebuild: the ordering
constraint is native rather than `workflow_run` plumbing, the image digests
arrive as job outputs rather than as a second GHCR API lookup, and both
artifacts share one concurrency group so two merges cannot race.

The observability chart bakes no fortymm images and so does not wait for them.

Consequently the chart inherits the images' critical path — a chart is not
pullable until the ~25-minute emulated-arm64 image build finishes. That is not
a new delay, only a relocated one: `redeploy-uat.sh` already waited for exactly
those digests. The wait now happens against the chart, and waiting for the
chart implicitly waits for the images.

**Charts get no moving `main` tag.** Helm derives the OCI tag from the chart
version, so a second tag would mean packaging twice or reaching for `oras`, and
nothing would consume it: the deploy script resolves by commit, and an outside
deployer wants a pinned version rather than a moving one. The images keep
`:main` because `values.yaml` uses it as the render fallback when no digest is
set; charts have no equivalent need.

## Consequences

- **`redeploy-uat.sh` deploys the published chart, not the working tree.** It
  would have been easier to keep rendering `deploy/fortymm/` from disk, but then
  nothing would ever exercise the published artifact and the first person to
  discover it was broken would be someone outside this repo. See
  `.claude/rules/verify-the-artifact-under-test.md` — UAT is the only thing that
  proves the chart we publish is the chart that works.
- **The script sheds its image-digest resolution.** `ghcr_manifest_digest`,
  `resolve_published_digest` and `assert_digest` exist to resolve two image
  digests that now ride inside the chart. What remains is one chart lookup,
  resolved to a digest at deploy time so the operator names a commit while the
  cluster gets content-addressed bytes.

  This originally said the script would get *substantially smaller*. It did
  not, and the correction is worth keeping so nobody goes looking for the
  missing lines: 252 code lines became 235. The hand-rolled GHCR token mint and
  manifest walk disappeared, but the wait-for-CI logic did not — it moved onto
  the chart — and the reasoning it now has to explain is no less subtle. The
  win is that the deploy stopped reimplementing a registry client, not that
  there is less of it.
- **The observability deploy stops depending on two external Helm repos.**
  `helm dependency build` plus `helm repo add prometheus-community` and
  `grafana` run at deploy time today. Packaging vendors those dependencies
  inside the artifact, so the deploy path no longer reaches out to
  `prometheus-community.github.io` or `grafana.github.io` at all.
- **The packages are public without anyone flipping a switch.** Per the
  correction recorded in the images ADR, a package pushed by `GITHUB_TOKEN`
  with `packages: write` is linked to the publishing repository and inherits
  its visibility, and `mightymoose/fortymm` is public. Anonymous `helm pull`
  works, and no chart needs `imagePullSecrets`.
- **Publishing lands before anything consumes it.** `publish.yml` runs on push
  to `main` only, so the first chart package cannot exist until the PR that adds
  the job has merged — there is no way to prove the job works from a PR. If the
  same merge also switched `redeploy-uat.sh` to pulling from the registry, a bug
  in the new job would leave UAT undeployable with the local-directory path
  already deleted, and the images ADR removed the `--local` escape hatch that
  would otherwise have been the way back. So the chart job ships and is
  confirmed publishing first; the script switch and the rename follow in a
  separate change.
- **Secrets remain out of band.** The `fortymm-uat-env` and `-apns` Secrets are
  created from the operator's `.env`, and no published artifact can carry them.
  A checkout-free deploy still means the deployer supplies their own secrets.
