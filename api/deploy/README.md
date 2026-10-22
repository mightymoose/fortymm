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
   (`us-central1-docker.pkg.dev/fortymm/fortymm/api` is the image);
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

## Deploying by hand

With `gcloud` logged in as an account that has the deployer's roles (an
owner works) and Docker running:

```sh
./bin/mise run api:deploy                       # build, push, deploy; prints the URL
API_ORIGIN=$(./bin/mise run api:url) ./bin/mise run web-client:deploy
```
