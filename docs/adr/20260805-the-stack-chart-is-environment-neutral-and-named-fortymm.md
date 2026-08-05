# The stack chart is environment-neutral and named `fortymm`

The chart that describes the fortymm stack was named `fortymm-uat` and lived in
`deploy/uat/`, because UAT was the only thing that ran it. Publishing it to a
registry makes that name a public fact rather than a local one — `helm push`
appends the chart name to the repository path, so the package would have been
`…/charts/fortymm-uat`, and the Hetzner production deploy (issue #1255) would
have installed a chart whose name asserts it is not production.

The chart is renamed **`fortymm`** and moved to `deploy/fortymm/`. Environment
is a property of the *values*, not of the chart.

## The chart was already neutral; only its labelling was not

This rename is cheap because the templates never encoded the environment. A
sweep for `uat` across `deploy/uat/templates/` finds two passing mentions in
comments and nothing else — every environment-specific fact (the
`uat.fortymm.com` hostnames, the MCP public URLs, the tailnet hostname, the
names of the out-of-band Secrets) was already a value. The environment was
baked into three places only:

1. the chart name, and therefore the published package name,
2. `app.kubernetes.io/name: fortymm-uat`, a literal in the labels and selector,
3. the directory, and the UAT-shaped defaults in `values.yaml`,
4. `appVersion: "uat"` — in **both** `Chart.yaml` files, including
   observability's.

The fourth is the odd one, because `appVersion` is supposed to name the version
of the application the chart deploys, and `"uat"` is not a version of anything.
It was harmless while the chart was a local directory. Published, it appears in
`helm show chart` output as the answer to "what does this deploy?", so CI stamps
the commit with `helm package --app-version` alongside `--version`. Both charts
get this; it is the one environment-neutrality fix the observability chart also
needs.

So this is a rename plus a values split, not a re-architecture, and it is worth
recording that the structure was already right — a future reader should not go
looking for the parameterisation work, because there wasn't any.

## Renaming the selector label costs one UAT reinstall

`app.kubernetes.io/name` appears in `fortymm-uat.selector`, which renders into
`spec.selector.matchLabels`. **That field is immutable in Kubernetes**, so
changing the literal makes `helm upgrade` fail outright rather than roll. The
existing release must be `helm uninstall`ed and reinstalled once.

**The failure is confirmed, not predicted.** A server-side dry run against the
live cluster answers:

```
The Deployment "api" is invalid: spec.selector: Invalid value:
{"matchLabels":{"app.kubernetes.io/component":"api","app.kubernetes.io/name":"fortymm"}}:
field is immutable
```

**But `helm uninstall` is the wrong remedy, and this ADR originally called for
it.** Uninstalling deletes the `postgres-data` PVC — no resource in the chart
carries `helm.sh/resource-policy: keep` — so it wipes UAT's database, which the
migrate-and-seed hook then rebuilds. That cost was accepted before anyone
checked whether it was necessary. It is not. Only the **Deployments** carry the
immutable field, so deleting just those and re-running the deploy is enough:

```bash
export KUBECONFIG="$(k3d kubeconfig write fortymm-uat)"
kubectl delete deploy api web-client worker nginx postgres redis tailscale -n fortymm-uat
mise run redeploy-uat
```

Helm recreates them on the next upgrade with the new selector. The release
history, the `postgres-data` PVC and the `tailscale-state` Secret all survive,
so **UAT's data is not wiped** and the tailnet identity is not at risk. UAT is
down for the minute or two the recreate takes.

The rejected alternative — rendering the selector label from `.Release.Name` so
it stays `fortymm-uat` and no reinstall is needed at all — is worse than it
looks. It would put the environment back into the label this ADR exists to take
it out of, and make every future release name part of the selector contract.

The tailscale state Secret is created by the tailscale container on first run
under its own RBAC rule, not templated by Helm, so `helm uninstall` does not
remove it and the tailnet identity survives. This matters: losing it is what
produces the `fortymm-uat-1` / `grafana-1` / `loki-1` node renames that a full
cluster delete causes. **Confirm the Secret is still there before reinstalling**
rather than trusting this paragraph — the claim is read off the templates, not
off a cluster.

The alternative was to rename the chart while leaving the label literal at
`fortymm-uat` forever. It avoids the reinstall and leaves a permanent lie in
every object's labels. Rejected: the reinstall only ever gets more expensive,
and doing it while the sole consumer is a disposable UAT stack is the cheapest
this will ever be. Once a Hetzner production release exists, the same immutable
field costs a production reinstall.

## Environment values live beside the chart, not inside it

`deploy/fortymm/values.yaml` carries neutral defaults. UAT's concrete values
move to `deploy/environments/uat.yaml`, which `redeploy-uat.sh` passes with
`-f`. The observability chart's one environment-specific value — the
`uat.fortymm.com` entry in the Faro CORS allowlist — moves the same way.

The rejected alternative was shipping `values-uat.yaml` *inside* the packaged
chart, so a deployer could `helm pull --untar` and reference it with zero git.
It is genuinely more self-sufficient, and it was turned down because it puts one
environment's hostnames back inside the artifact this ADR exists to make
environment-neutral. The consequence is accepted deliberately: **a UAT deploy
still needs this repo checked out for its values file.** The checkout-free
promise is for *other* environments, which bring their own values, and for
reading or inspecting the chart anywhere.

## Consequences

- **Every `fortymm-uat.*` template helper is renamed `fortymm.*`** across
  `_helpers.tpl` and the ten templates that call them. Purely mechanical: no
  resource name derives from the chart name, because `metadata.name` values are
  hardcoded literals (`api`, `postgres`) and the chart has no `fullname` helper.
- **The release name is unaffected.** It is a CLI argument, and
  `app.kubernetes.io/instance` reads `.Release.Name`, so the release may stay
  `fortymm-uat` to name the *environment* even though the chart no longer does.
- **`deploy/CLAUDE.md` and `scripts/redeploy-uat.sh` reference `deploy/uat/`
  throughout** and move with the directory. So does the `nginxConf` note about
  keeping `nginx/uat.conf` in sync with the inline copy in `_helpers.tpl`.
- **The observability chart keeps its name.** `observability` says nothing about
  an environment, and renaming it would rename its resources for no gain. The
  `fortymm/` segment in the registry path is what scopes it — a bare
  `ghcr.io/mightymoose/observability` package would be far too generic for an
  account that may host other projects.
