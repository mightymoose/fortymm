# Deploying the API

The API runs on Google Cloud Run in project `fortymm`, region `us-central1`
(the defaults of `GCP_PROJECT` and `GCP_REGION` in the repo's `mise.toml`),
behind the Cloudflare Worker that serves the web-client: the Worker forwards
`https://fortymm.com/api/*` to it with the `/api` prefix stripped. The API
answers 403 to any request without the Worker secret, which only the Worker
sends. CLAUDE.md's Deploy section describes how it all fits together.

- `../Dockerfile`: the production image (`./bin/mise run api:build`).
- `cloud-run-deploy`: pushes the image and deploys it, to the `api` service
  (`./bin/mise run api:deploy`) or as a tagged, no-traffic revision of the
  `api-preview` service (`./bin/mise run api:preview`).
- `preview-database`: creates or drops a Preview's own database (see The
  database below).
- `bootstrap-gcp.sh`: the one-time project setup below.
- `setup-auth0`: the one-time Auth0 setup (see Auth0 below).
- `auth0.env`: the Auth0 tenant's domain and client IDs, which `setup-auth0`
  writes and `cloud-run-deploy` reads.
- `apply-auth0-branding` and `auth0-branding/`: the look of the Auth0
  sign-in page (see The sign-in page below).
- `cleanup-policy.json`: the Artifact Registry cleanup policy it applies (see
  Image cleanup below).

## One-time setup

You need the `gcloud` CLI, logged in (`gcloud auth login`) as an owner of a
GCP project with billing enabled, and that project's ID (`fortymm` unless you
pass another). Then, from the repo root:

```sh
api/deploy/bootstrap-gcp.sh fortymm us-central1
```

It's idempotent, so re-running it is safe. It:

1. enables the Cloud Run, Artifact Registry, IAM, IAM Credentials, Security
   Token Service, Secret Manager, Cloud Billing Budget, Cloud SQL Admin and
   Cloud SQL APIs. The script then waits, up to about 2 minutes, until each API that a
   later step calls answers.
2. creates the `fortymm` Docker repository in Artifact Registry
   (`us-central1-docker.pkg.dev/fortymm/fortymm/api` is the image), tags the
   image the `api` service serves (if it exists yet) as `production`, and
   applies `cleanup-policy.json` to the repository (see Image cleanup).
3. creates three service accounts:
   - `github-deployer`, which CI deploys as, with `roles/run.admin` and
     `roles/artifactregistry.writer` on the project,
     `roles/artifactregistry.repoAdmin` on the `fortymm` repository (moving
     the `production` tag needs it) and `roles/iam.serviceAccountUser` on
     `api-runtime` and `api-preview-runtime`. It also gets the custom role
     `previewDatabases` on the project, which the script creates or updates.
     The role lets CI create, list and drop databases on the instance, and
     nothing else. `roles/cloudsql.editor` would also let CI change and
     restart the instance.
   - `api-runtime`, which production (the `api` service) runs as, with
     `roles/cloudsql.client` on the project.
   - `api-preview-runtime`, which the Previews (the `api-preview` service)
     run as, with `roles/cloudsql.client` on the project. Branch code runs
     as this account, so it can't read production's database password.
4. creates the Worker secret, the Secret Manager secret `api-worker-secret`,
   with a random 64-character hex value, if it doesn't exist. It never prints
   the value. `api-runtime`, `api-preview-runtime` and `github-deployer` get
   `roles/secretmanager.secretAccessor` on it, and `github-deployer` also gets
   `roles/secretmanager.viewer`, so CI can list its versions.
5. creates the Cloud SQL instance `fortymm` if it doesn't exist: Postgres 18,
   Enterprise edition, `db-f1-micro`, 10 GB of SSD, in the region. The create
   takes about 15 minutes. The script prints the instance's state every 30
   seconds until it's `RUNNABLE`, and a re-run waits the same way. Postgres 16 and later default to the Enterprise
   Plus edition, which costs far more and has no shared-core tiers. Then it
   creates the production database `fortymm` and each user:

   | User | Password secret | Readable by |
   | --- | --- | --- |
   | `api` | `api-database-password` | `api-runtime` |
   | `api_preview` | `api-preview-database-password` | `api-preview-runtime` |

   It creates no Preview database. Each Preview gets its own on its first
   deploy (see The database below).

   If a password secret doesn't exist, the script creates it with a random
   64-character hex value. It never replaces an existing one, and it never
   prints the value. It then sets the user's password to the secret's latest
   value, so a re-run converges the two.
6. creates the Workload Identity pool `github` and its OIDC provider `github`,
   which accepts GitHub Actions tokens from `mightymoose/fortymm` only, and
   lets that repository's workflows impersonate `github-deployer`, so CI needs
   no service-account key.
7. creates the Secret Manager secrets `auth0-client-secret` and
   `auth0-preview-client-secret`, with no value. `setup-auth0` adds the
   values. `api-runtime` can read only the first, and `api-preview-runtime`
   only the second.
8. creates the budget `FortyMM (<project>)` on the project's billing account,
   if it doesn't exist: $25 a month for this project, with alerts at 40% ($10)
   and 100% ($25). It sets no recipients, so Google Cloud emails the billing
   account's admins and users.

It ends by printing the two GitHub Actions **variables** to add (Settings >
Secrets and variables > Actions > Variables; neither is a secret):

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project number>/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `github-deployer@fortymm.iam.gserviceaccount.com` |

The Cloud SQL instance runs all the time. `db-f1-micro` with 10 GB of SSD
costs about $9-10 a month, so the budget's $10 alert will likely fire most
months.

Until both are set, CI skips the API deploys (with a warning) and deploys the
Worker with no `API_ORIGIN`, so `/api/*` answers 503.

The services allow unauthenticated requests (`allUsers` gets
`roles/run.invoker`). The Worker secret, not Cloud Run, restricts them to the
Worker. If the project is in an organization whose policy
restricts IAM members to its domain (`iam.allowedPolicyMemberDomains`), the
first deploy fails until that policy allows `allUsers` for this project.

## Auth0

Production and the Previews sign in through one Auth0 tenant. It has two
applications of type Regular Web Application:

| Application | Allowed callback URLs | Allowed logout URLs | Client secret | Used by |
| --- | --- | --- | --- | --- |
| `fortymm` | `https://fortymm.com/api/v1/auth/callback` | `https://fortymm.com/signed-out` | `auth0-client-secret` | `api` |
| `fortymm-preview` | `https://*-fortymm.mightymoose.workers.dev/api/v1/auth/callback` | `https://*-fortymm.mightymoose.workers.dev/signed-out` | `auth0-preview-client-secret` | `api-preview` |

The tenant has only two connections, the email code (Passwordless Email) and
Google. The API links a Google login and an email code login to one account
by their verified email. That is only as safe as the weakest connection's
email check. So review any other connection before you turn it on.

After `bootstrap-gcp.sh`, run the wizard from the repo root:

```sh
api/deploy/setup-auth0 fortymm
```

It walks you through the Auth0 dashboard and the Google Cloud console. It
uses the tenant that Auth0 sign-up makes, because the free plan charges for
a second one. It sets up a Google OAuth client for the Google connection, both
applications and their connections. It deletes the password connection. It
adds each client secret to Secret Manager with gcloud, and never writes it to
a file. It writes `AUTH0_DOMAIN`, `AUTH0_CLIENT_ID` and
`AUTH0_PREVIEW_CLIENT_ID` to `auth0.env`. These values are public, so commit
the file. A re-run offers the saved values as defaults.

`cloud-run-deploy` reads `auth0.env` before it pushes the image, and fails if
the file is missing. It sets `AUTH0_DOMAIN` and the target's
`AUTH0_CLIENT_ID`, and mounts the target's client secret as
`AUTH0_CLIENT_SECRET` at `latest`. The API doesn't start on Cloud Run without
all three.

The post-deploy suite checks that a Preview's `GET /api/v1/auth/login`
answers 302 to the tenant's `/authorize`, with the Preview's client ID and
callback URL. It doesn't sign in. So after a change to the tenant, sign in on
a Preview with an email code and with Google.

### The sign-in page

`apply-auth0-branding` gives the tenant's Universal Login page the design
system's look. It reads the files in `auth0-branding/`:

- `theme.json`: the colours, borders, font and logo of the page. The font
  is Space Grotesk from Google Fonts, because Auth0 loads it from another
  origin and needs CORS. The logo is `https://fortymm.com/logo-wordmark.svg`,
  the reference's wordmark with its text drawn as paths.
- `settings.json`: the primary colour, the page background, the logo and
  the favicon.
- `tenant.json`: the tenant's name, so the page says FortyMM and not the
  tenant's generated name.
- `custom-text.json`: the titles and descriptions of the sign-in screens.

Production and the Previews share the tenant, so the script changes the
page for both. The logo and favicon come from production, so deploy `main`
before the first run. Get a Management API token in the Auth0 dashboard,
under Applications > APIs > Auth0 Management API > API Explorer. Then run:

```sh
AUTH0_MANAGEMENT_TOKEN=<token> api/deploy/apply-auth0-branding
```

The script fails if the tenant uses the Classic Universal Login. Before it
changes anything, it saves the current settings to a backup directory and
prints its path. To change the page, edit the files and run it again.

### A custom domain

Auth0 can serve the sign-in page on `auth.fortymm.com` instead of the
tenant's domain. The free plan allows one custom domain after you add a
credit card. Do these steps in order:

1. In Auth0, open Branding > Custom Domains. Add `auth.fortymm.com` with
   Auth0-managed certificates.
2. In Cloudflare, add the CNAME record that Auth0 shows to the `fortymm.com`
   zone. Set it to DNS only. A proxied record breaks Auth0's certificate.
   Then verify the domain in Auth0.
3. In the Google Cloud console, add
   `https://auth.fortymm.com/login/callback` to the Google OAuth client's
   authorized redirect URIs. Keep the tenant's URI. Without the new URI,
   Google sign-in fails with `redirect_uri_mismatch`.
4. Check that
   `curl https://auth.fortymm.com/.well-known/openid-configuration` shows
   `"issuer":"https://auth.fortymm.com/"`.
5. In `auth0.env`, add `AUTH0_TENANT_DOMAIN` with the old value of
   `AUTH0_DOMAIN`, then set `AUTH0_DOMAIN=auth.fortymm.com`. The API reads
   the issuer from the discovery document, so it accepts the new tokens.
   `apply-auth0-branding` uses `AUTH0_TENANT_DOMAIN`, because the
   Management API answers only on the tenant's domain.
6. Push a branch, and sign in on its Preview with an email code and with
   Google. The post-deploy suite checks only the redirect to `/authorize`.

A session signed in before the switch stays valid, because the API keeps
its own sessions.

To rotate a client secret, rotate it in the application's settings in
Auth0. That ends the old one. Add the new one as a version of its secret,
then redeploy. Sign-in fails between the rotation and the redeploy.

```sh
printf '%s' '<new client secret>' |
  gcloud secrets versions add auth0-client-secret --project fortymm --data-file=-
```

## The database

`cloud-run-deploy` mounts the instance with `--add-cloudsql-instances` and
sets `DATABASE_URL` to a Unix-socket URL with no password, such as
`postgresql://api@/fortymm?host=/cloudsql/fortymm:us-central1:fortymm`.
libpq reads the password from `PGPASSWORD`, which Cloud Run sets from the
target's password secret at `latest`. The password only changes together
with the database user, so a cold start reads the newest one. The Worker
secret is pinned to a version for a different reason (see Rotating the
Worker secret).

Each Preview gets its own database, `fortymm_preview_<name>`, because the
API migrates its database at startup and two branches can have different
schemas. `preview-database` owns the name, with the Preview name's dashes
changed to underscores. `cloud-run-deploy` runs `preview-database create` on
each Preview deploy. If the database exists, the create does nothing.
`mise run api:preview-delete` runs `preview-database drop`, and the
preview-cleanup workflow runs that task when a branch is deleted. Cloud SQL
runs one admin operation per instance at a time, so two branches' CI runs
can collide. `preview-database` retries only that error, every 15 seconds
for about 5 minutes.

The instance allows 25 connections. Production holds up to 12 (3 instances
with 4 each), and each warm Preview holds up to 4, so about 3 warm Previews
fit at once.

Production and the Previews share one instance. The split is per user and
per database, not hard isolation. Postgres lets any user connect to any
database by default, and Cloud SQL makes every user that gcloud creates a
member of `cloudsqlsuperuser`. So the database roles alone don't keep
`api_preview` out of `fortymm`. What keeps branch code out is that it runs
as `api-preview-runtime`, which can't read `api-database-password`.

To change a database password, add a version to its secret, then re-run
`bootstrap-gcp.sh`, which sets the user's password from it. Running
instances keep the old password in `PGPASSWORD`, so their new connections
fail until they restart. Redeploy the service right after.

## Image cleanup

CI pushes `api:<commit>` on every push, from `main` and from every branch, so
the repository has a cleanup policy (`cleanup-policy.json`) to stop it
growing:

- `delete-older-than-30-days`: delete versions (images) pushed more than 30
  days ago;
- `keep-10-most-recent-api`: keep the 10 most recently pushed versions of
  `api`, however old;
- `keep-production`: keep the version tagged `production`.

A keep rule wins over a delete rule, so a version is deleted only if it is
older than 30 days, not one of the 10 newest, and not `production`. The 10
count every push, Previews included, so a production image can be among
the oldest; that's what `production` is for. Cloud Run pins a revision's
image by digest and Artifact Registry doesn't know which images revisions
use, so deleting the serving one would stop production starting new
instances (it scales to zero) or being rolled back to.
`cloud-run-deploy` moves the `production` tag to each image it deploys to
`api`, after the deploy succeeds. If you change production's traffic by hand
(e.g. rolling back to an older revision with `gcloud run services
update-traffic`), re-run `bootstrap-gcp.sh`, which points the tag at the
revision with the most traffic. Older production revisions and Preview
revisions are only as safe as the rules above, so rolling back past them
isn't possible once their images are gone.

Policies run in a background job, and changes take effect within about a
day. Re-running `bootstrap-gcp.sh` replaces the repository's policies with
the file's, and enforces them. To see what they would delete first, apply
them in dry-run mode:

```sh
api/deploy/bootstrap-gcp.sh --cleanup-dry-run fortymm us-central1
```

In dry-run mode nothing is deleted; the deletions it would make show in the
project's Data Access audit logs (enable the Artifact Registry API's **Data
write** logs first) as `BatchDeleteVersions` calls with `validateOnly` set,
after a day or so. Then re-run the script without the flag to enforce the
policy. `gcloud artifacts repositories list-cleanup-policies fortymm
--location us-central1` shows the policies and whether dry run is on.

## Deploying by hand

With `gcloud` logged in as an account that has the deployer's roles (an
owner works) and Docker running:

```sh
./bin/mise run api:deploy                       # build, push, deploy; prints the URL
WORKER_SECRET=$(gcloud secrets versions access latest --secret api-worker-secret --project fortymm) \
  API_ORIGIN=$(./bin/mise run api:url) ./bin/mise run web-client:deploy
```

`api:deploy` uses the newest enabled version of the Worker secret. `latest` is
the newest version, so the two match unless that version is disabled.

## Rotating the Worker secret

Add a version, then push `main`:

```sh
openssl rand -hex 32 | tr -d '\n' |
  gcloud secrets versions add api-worker-secret --project fortymm --data-file=-
```

CI deploys the API and then the Worker with the new version. Production
answers 403 for about a minute between the two deploys. Each Preview picks up
the new version on its next push. Then disable the old version to retire it:

```sh
gcloud secrets versions disable <old version> --secret api-worker-secret --project fortymm
```

A Preview revision still pinned to a disabled version can't start, so push
its branch again before you disable the version.
