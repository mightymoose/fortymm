# Deploy

Production is `https://fortymm.com`: a Cloudflare Worker serves the
web-client and forwards `/api/*` to the API on Google Cloud Run, so the app's `/api` client is same-origin, as in dev, with no CORS.

The API's `*.run.app` URLs are public, so the Worker proves each request came
through it. It sends the Worker secret in the `X-FortyMM-Worker-Secret`
header, and the API answers 403 to any request without it. The Worker also
answers 429 to a client IP that sends more than about 100 `/api/*` requests
a minute to one Cloudflare machine. A client that opens a new connection per
request reaches many machines, so this limit doesn't stop it (#88). The API
limits guest accounts itself (see Accounts and sessions). The Worker secret section below describes where the value lives.

```sh
./bin/mise run api:deploy           # build, push and deploy the API; prints its URL last
./bin/mise run api:preview          # the same, as this branch's Preview revision
./bin/mise run api:url              # print the production API's URL
./bin/mise run web-client:deploy    # wrangler deploy of web-client/dist and the Worker
./bin/mise run web-client:preview   # a Cloudflare Preview named after the git branch
./bin/mise run api:preview-delete <branch>         # remove that branch's API Preview tag and database
./bin/mise run web-client:preview-delete <branch>  # delete that branch's Cloudflare Preview
```

CI deploys on every push after `ci` passes, the API first, so the Worker
never points at a route that isn't there yet:

- `main`: `api:deploy`, then `web-client:deploy` with `API_ORIGIN` set to the
  URL it printed.
- Any other branch: `api:preview`, then `web-client:preview` with
  `API_ORIGIN` set to that revision's URL, so each Cloudflare Preview talks to
  the API built from the same commit. Both Preview URLs are in the deploy
  steps' logs.

Before the deploys, CI pins one version of the Worker secret, and both
deploys use it. After the API deploy, CI requests `$API_ORIGIN/v1/health`
without the header and fails unless the API answers 403.

Then CI runs the post-deploy suite (`web-client:e2e-deployed`, see
End-to-end tests) against what it just deployed:

- Any other branch: against the Cloudflare Preview, whose URL the deploy step
  takes from wrangler's `Preview URL:` line (failing if it's missing). This
  checks the branch's full stack, Worker, assets and API revision, before
  it's merged.
- `main`: against `https://fortymm.com` after `web-client:deploy`. Production
  has already changed by then, so this detects a broken deploy rather than
  preventing one. It runs only the health check, so it makes no account.

Both are skipped while the API deploys are (see below), since `/api/*`
answers 503 then.

When a branch other than `main` is deleted,
`.github/workflows/preview-cleanup.yml` removes its Previews.
GitHub runs the workflow from `main`, so the deleted branch's name comes from
the `delete` event. The workflow runs `api:preview-delete` and then
`web-client:preview-delete` with that name. Each task succeeds if its Preview
isn't there. The workflow skips the API step while the API deploys are
skipped. It uses the CI concurrency group of the deleted branch. So it waits
for that branch's running CI deploy, and a CI deploy can't recreate the
Previews after the cleanup.

## web-client (Cloudflare Workers)

`web-client/wrangler.jsonc` configures it. `worker/index.ts` is the Worker
(unit-tested in `worker/index.test.ts`): requests to `/api/*` go to
`API_ORIGIN` with the `/api` prefix stripped, keeping the method, headers,
query and body and setting `X-Forwarded-Host`, `X-Forwarded-Proto` and
`X-Forwarded-For`; with no `API_ORIGIN` they get a 503. The Worker sets
`X-FortyMM-Worker-Secret` from `WORKER_SECRET`, and removes a client's own
copy when `WORKER_SECRET` is empty. Before it forwards a request, the
`API_RATE_LIMIT` binding (`ratelimits` in `wrangler.jsonc`) counts it against
the client's `CF-Connecting-IP`. Above about 100 requests a minute, the
Worker answers 429 with `Retry-After: 60`. Each Cloudflare machine keeps its
own count and shares it in the background, so the limit is approximate. A
client on one keep-alive connection gets 429 after about 100 requests. A
client that opens a new connection per request was never limited in
production or a Preview (#88). Previews get only the bindings under
`previews` in `wrangler.jsonc`, so that block repeats the rate limit. If
`CF-Connecting-IP` is missing, the Worker deletes the client's own
`X-Forwarded-For`, because the API keys guest accounts by it.
Everything else goes to the static assets in `dist/` (the `ASSETS` binding).
`assets.run_worker_first: true` runs the Worker before the assets for every
path, so the host redirect below also covers `/`. When the Worker passes a
request to `ASSETS`, `not_found_handling: "single-page-application"` serves
`index.html` for any path with no matching file. So client-side routes load
directly.

`API_ORIGIN` isn't in `wrangler.jsonc`: `web-client:deploy` and
`web-client:preview` pass it with `--var` from the environment (CI sets it
from the API deploy), and warn if it's empty. They also pass `WORKER_SECRET`
from the environment, with `--secrets-file`. wrangler runs in the `dev`
container, so the tasks write the file there. If `WORKER_SECRET` is empty,
they warn that the API will answer the Worker with a 403.

Production is served on `fortymm.com` and `www.fortymm.com` (Custom Domains
in `routes`, whose DNS records and certificates Cloudflare manages). Each host
has its own cookie jar. So the Worker answers requests on `www.fortymm.com`
with a 301 to the same path and query on `fortymm.com`, and a browser keeps one
cookie jar. This includes `/api/*` paths.

The Worker's own workers.dev URL, `fortymm.mightymoose.workers.dev`, is off.
Cloudflare answers it with a 404 (error 1042) and never runs the Worker. The
Worker still lists it with `www.fortymm.com`, so the URL redirects to
`fortymm.com` if someone turns it on. The Worker names both hosts exactly,
so Previews get no redirect.

Previews (`wrangler preview`, open beta) are served on
`<preview-name>-fortymm.mightymoose.workers.dev` because `preview_urls` is on in
`wrangler.jsonc`; changes to that setting only take effect after a production
deploy. `bin/preview-name` makes the name from the branch (`claude/foo_bar` ->
`claude-foo-bar`, at most 30 characters, starting with a letter); the API's
Preview revision uses the same name as its tag. `bin/preview-name` takes an
optional branch name and defaults to the current branch, so it can also name
a deleted branch.

The tasks deploy whatever is in `web-client/dist`, so build first (CI deploys
the build `ci` just tested). They need `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` in the environment; CI reads them from the repo's
Actions secrets of the same names.

`web-client:preview-delete` runs `npm ci` and then `wrangler preview delete
--name <name> -y`. wrangler can't check whether a Preview exists first. So
the task reads wrangler's error when the delete fails. If the request to the
Preview API failed with a "not found" error, the task succeeds.

## api (Cloud Run)

The API runs on Cloud Run in GCP project `fortymm`, region `us-central1`
(`GCP_PROJECT` and `GCP_REGION` in `mise.toml`'s `[env]`; set either in the
environment to override). `api:deploy` and `api:preview` build the production
image, push it to Artifact Registry as
`us-central1-docker.pkg.dev/fortymm/fortymm/api:<commit>`, and run
`gcloud run deploy` through `api/deploy/cloud-run-deploy`, which holds the
service settings: min instances 0 (scale to zero), max 3 (1 for Previews),
1 CPU, 256 MiB, unauthenticated access, with the Worker secret as
`WORKER_SECRET`, the Cloud SQL database and Auth0 (see below). Production runs as
the `api-runtime` service account, and Previews as `api-preview-runtime`.
They need `gcloud` logged in as an account that can deploy, and Docker.

- `api:deploy` deploys the `api` service, and the new revision takes all its
  traffic.
- `api:preview` deploys a revision of a separate `api-preview` service tagged
  with the branch's Preview name and no traffic, served on
  `https://<preview-name>---<api-preview's host>`. Each push moves the tag to
  the new revision. Keeping Previews on their own service means a branch
  deploy can never change production's traffic or settings. The revision
  uses the branch's own database (see The database below).
- `api:preview-delete <branch>` removes the branch's tag from `api-preview`
  (`gcloud run services update-traffic --remove-tags`), then drops the
  branch's database. It first checks that the service and the tag exist, and
  skips the tag removal if either is missing. It drops the database in every
  case, because a database can outlive its tag. The revision stays, untagged
  and with no traffic. Cloud Run keeps a limited number of revisions per
  service, and an idle revision costs nothing, so nothing deletes revisions.

### The database

The API's database is the Cloud SQL instance `fortymm` (Postgres 18,
Enterprise edition, `db-f1-micro`, 10 GB SSD) in the same region.
`cloud-run-deploy` mounts it with `--add-cloudsql-instances` and sets
`DATABASE_URL` to its Unix socket. libpq reads the password from
`PGPASSWORD`, which Cloud Run sets from a secret at `latest`:

| Target | Database | User | Password secret | Runs as |
| --- | --- | --- | --- | --- |
| `api` | `fortymm` | `api` | `api-database-password` | `api-runtime` |
| `api-preview` | `fortymm_preview_<name>` | `api_preview` | `api-preview-database-password` | `api-preview-runtime` |

Each Preview gets its own database, because the API migrates its database at
startup and two branches can have different schemas.
`api/deploy/preview-database` makes the name. It is `fortymm_preview_` and
then the Preview name with dashes changed to underscores
(`feat-db-per-preview` -> `fortymm_preview_feat_db_per_preview`). `cloud-run-deploy` creates the
database on the branch's first Preview deploy. `api:preview-delete` drops it,
and the preview-cleanup workflow runs that task when the branch is deleted.
All Previews connect as `api_preview`. Cloud SQL runs one admin operation per
instance at a time, so `preview-database` retries a create or drop that
collides with another one for about 5 minutes.

Only the matching runtime service account can read each password secret, so
branch code can't read production's password. The instance allows 25
connections. Production holds up to 12 (3 instances with 4 each), and each
warm Preview holds up to 4, so about 3 warm Previews fit at once. The
instance costs about $9-10 a month and never scales to zero.

### The Worker secret

The Worker secret is a 64-character hex value in Secret Manager, as the
secret `api-worker-secret`. Cloud Run allows unauthenticated requests, so the
Worker secret is the only thing that keeps clients from going around the
Worker.

- `cloud-run-deploy` mounts it as `WORKER_SECRET` at a pinned version number:
  `WORKER_SECRET_VERSION` if set, otherwise the newest enabled version. It
  never uses `latest`. Instances scale to zero and read `latest` again on each
  cold start, so a new version would reach the API before the Worker.
- CI sets `WORKER_SECRET_VERSION` once per run. The Cloudflare deploy steps
  read that version with `gcloud secrets versions access`, mask it in the
  log, and pass it to `web-client:deploy` or `web-client:preview` as
  `WORKER_SECRET`. The value stays in those steps.
- Cloud Run sets `K_SERVICE`. If `K_SERVICE` is set and `WORKER_SECRET` is
  not, `create_app()` raises, so the revision fails to start instead of
  serving the API to anyone.

To rotate the Worker secret, add a version, then push `main`:

```sh
openssl rand -hex 32 | tr -d '\n' |
  gcloud secrets versions add api-worker-secret --project fortymm --data-file=-
```

Production answers 403 for about a minute, between the API deploy and the
Worker deploy. Each Preview picks up the new version on its next push. After
that, disable the old version (`gcloud secrets versions disable <n> --secret
api-worker-secret --project fortymm`) to retire it. A Preview revision still
pinned to a disabled version can't start, so push its branch again first.

CI authenticates to Google Cloud with Workload Identity Federation
(`google-github-actions/auth`; no service-account key), as the
`github-deployer` service account, from two Actions **variables**:
`GCP_WORKLOAD_IDENTITY_PROVIDER` and `GCP_SERVICE_ACCOUNT`. Until both are
set, CI skips the API deploys with a warning, and the Worker answers `/api/*`
with a 503.

The Artifact Registry repository has a cleanup policy
(`api/deploy/cleanup-policy.json`, applied by `bootstrap-gcp.sh`): it deletes
images older than 30 days except the 10 newest and the one tagged
`production`, which `cloud-run-deploy` moves to each production deploy.

The one-time GCP setup (enabling the APIs, the Artifact Registry repository,
the service accounts and their roles, the Worker secret, the Cloud SQL
instance with its databases, users and password secrets, the two Auth0
client secrets with no value, the Workload
Identity pool and provider for `mightymoose/fortymm`, the budget) is
`api/deploy/bootstrap-gcp.sh`, run once by a project owner; it prints the
variables to set. `api/deploy/README.md` describes it step by step.

The budget `FortyMM (fortymm)` covers the project's monthly spend. Google
Cloud emails the billing account's admins and users when the spend passes
$10 and $25. The Cloud SQL instance alone costs about $9-10 a month, so the
$10 alert will likely fire most months.

### Auth0

Production and the Previews sign in through one Auth0 tenant, with two
applications of type Regular Web Application. The tenant has only the
email code and Google connections, because the API links logins by verified
email (see Sign-in).

| Target | Auth0 application | Allowed callback URLs | Client secret |
| --- | --- | --- | --- |
| `api` | `fortymm` | `https://fortymm.com/api/v1/auth/callback`, `https://fortymm.com/api/v1/auth/app-callback` | `auth0-client-secret` |
| `api-preview` | `fortymm-preview` | `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/callback`, `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/app-callback` | `auth0-preview-client-secret` |

Each application's allowed logout URL is its origin with `/signed-out`.
`api/deploy/auth0.env` holds `AUTH0_DOMAIN`, `AUTH0_TENANT_DOMAIN`,
`AUTH0_CLIENT_ID` and `AUTH0_PREVIEW_CLIENT_ID`. `AUTH0_DOMAIN` is the
custom domain `auth.fortymm.com`, where Auth0 serves the sign-in page.
`AUTH0_TENANT_DOMAIN` is the tenant's own domain, where the Management API
answers. These values are public, so the file is committed. `cloud-run-deploy` reads it before it pushes the image, and fails
without it. It sets `AUTH0_DOMAIN` and the target's `AUTH0_CLIENT_ID`. It
mounts the target's client secret as `AUTH0_CLIENT_SECRET` at `latest`, so a
cold start reads a rotated secret. Only the matching runtime service account
can read each client secret.

`api/deploy/setup-auth0` is a wizard that a person runs once, after
`bootstrap-gcp.sh`. It walks them through the Auth0 dashboard and the Google
Cloud console. It adds each client secret to Secret Manager and writes
`auth0.env`. `api/deploy/README.md` describes it.

`api/deploy/apply-auth0-branding` gives the tenant's sign-in page the
design system's look, from the files in `api/deploy/auth0-branding/`. A
person runs it with a Management API token. It changes the page for
production and the Previews at once. Its logo is
`web-client/public/logo-wordmark.svg`, served from `https://fortymm.com`.
`api/deploy/README.md` describes it, and the steps to serve the page on
`auth.fortymm.com`. `tenant.json` also points the tenant's error page at
`https://fortymm.com/sign-in-stopped`.
