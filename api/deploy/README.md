# Deploying the API

The API runs on Google Cloud Run in project `fortymm`, region `us-central1`
(the defaults of `GCP_PROJECT` and `GCP_REGION` in the repo's `mise.toml`),
behind the Cloudflare Worker that serves the web-client: the Worker forwards
`https://fortymm.com/api/*` to it with the `/api` prefix stripped. CLAUDE.md's
Deploy section describes how it all fits together.

- `../Dockerfile`: the production image (`./bin/mise run api:build`).
- `cloud-run-deploy`: pushes the image and deploys it, to the `api` service
  (`./bin/mise run api:deploy`) or as a tagged, no-traffic revision of the
  `api-preview` service (`./bin/mise run api:preview`).
- `bootstrap-gcp.sh`: the one-time project setup below.
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

1. enables the Cloud Run, Artifact Registry, IAM, IAM Credentials and
   Security Token Service APIs;
2. creates the `fortymm` Docker repository in Artifact Registry
   (`us-central1-docker.pkg.dev/fortymm/fortymm/api` is the image), tags the
   image the `api` service serves (if it exists yet) as `production`, and
   applies `cleanup-policy.json` to the repository (see Image cleanup);
3. creates two service accounts:
   - `github-deployer`, which CI deploys as, with `roles/run.admin` and
     `roles/artifactregistry.writer` on the project and
     `roles/iam.serviceAccountUser` on `api-runtime`;
   - `api-runtime`, which the API runs as, with no roles;
4. creates the Workload Identity pool `github` and its OIDC provider `github`,
   which accepts GitHub Actions tokens from `mightymoose/fortymm` only, and
   lets that repository's workflows impersonate `github-deployer`, so CI needs
   no service-account key.

It ends by printing the two GitHub Actions **variables** to add (Settings >
Secrets and variables > Actions > Variables; neither is a secret):

| Variable | Value |
| --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/<project number>/locations/global/workloadIdentityPools/github/providers/github` |
| `GCP_SERVICE_ACCOUNT` | `github-deployer@fortymm.iam.gserviceaccount.com` |

Until both are set, CI skips the API deploys (with a warning) and deploys the
Worker with no `API_ORIGIN`, so `/api/*` answers 503.

The services allow unauthenticated requests (`allUsers` gets
`roles/run.invoker`). If the project is in an organization whose policy
restricts IAM members to its domain (`iam.allowedPolicyMemberDomains`), the
first deploy fails until that policy allows `allUsers` for this project.

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
API_ORIGIN=$(./bin/mise run api:url) ./bin/mise run web-client:deploy
```
