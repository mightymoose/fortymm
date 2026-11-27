# fortymm

## Requirements (Dafny)

Product requirements are written as Dafny specs in `requirements/*.dfy` and checked with Z3 in a container.
Dafny and Z3 are installed in the image by mise, using `bin/mise` and `requirements/mise.toml`.

```sh
./bin/mise run requirements:check                  # verify all requirements
./bin/mise run requirements:check Example.dfy      # verify specific files (relative to requirements/)
./bin/mise run requirements:dafny -- --help        # any other dafny command
docker compose build check-requirements            # after changing requirements/mise.toml
```

See `requirements/Example.dfy` for the pattern: requirements as predicates, a consistency witness,
and operations proven to preserve every requirement from every valid state.

## Dev and verify

```sh
./bin/mise run dev                                 # every dev server (api, web client, design system reference), URLs printed; Ctrl-C stops
./bin/mise run dev --detach                        # same, but return once they are healthy
./bin/mise run verify                              # dev servers up, then lint + typecheck + tests (web client, api) + e2e + journeys
```

`verify` runs every check, then fails if any did. It reuses servers `dev` already started, and only stops the ones it started.

## Web client (Vite + React + TypeScript)

The app lives in `web-client/`. Node is installed in the image by mise from `web-client/mise.toml`; nothing runs on the host.

```sh
./bin/mise run web-client:dev                      # dev server on a random host port (URL printed at startup)
./bin/mise run web-client:npm -- install <pkg>     # any npm command in the container
./bin/mise run web-client:npm -- run build
./bin/mise run web-client:npm -- run lint
./bin/mise run web-client:api-client               # regenerate src/api/generated.ts from api/openapi.json (orval)
./bin/mise run web-client:e2e                      # Playwright e2e tests (Chromium, in the container)
./bin/mise run web-client:e2e -- --grep home       # any playwright test args
./bin/mise run journeys:test                       # whole-stack Playwright journeys against the dev servers
```

Each `web-client:dev` gets its own container and host port, so several can run at once. `./bin/mise run ports` lists them.
Dependencies are baked into the image; `web-client:dev` rebuilds it when `package.json` or the lockfile changes.

## API (FastAPI)

The api lives in `api/`. Python and uv are installed in the image by mise from `api/mise.toml`; dependencies are in
`api/pyproject.toml` and `api/uv.lock` and baked into the image. Every route is under `/api`, and the web client's
dev server proxies `/api` to the api, so the app calls it on its own origin in dev and preview.
The spec is committed as `api/openapi.json`. `verify` fails if it is stale, or if [oasdiff](https://github.com/oasdiff/oasdiff)
finds a breaking change against the spec on `main` (as of where the branch split off).

```sh
./bin/mise run api:dev                             # dev server on a random host port (docs URL printed at startup)
./bin/mise run api:test                            # pytest, in the container
./bin/mise run api:uv -- add <pkg>                 # any uv command in the container
./bin/mise run api:openapi                         # regenerate api/openapi.json (commit it)
```

## Preview (Tailscale Funnel)

`./bin/mise run preview` builds and starts everything: the web client's production build, served by nginx (`web-client/nginx.conf`,
with `/api` proxied to the api), behind a Tailscale sidecar that serves it on the internet at `https://fortymm.<tailnet>.ts.net`
via Funnel. There is no hot reload: re-run `preview` to pick up changes. No host ports are published; `web-client:dev` is unchanged.
The sidecar's config is `tailscale/serve.json` (Funnel on 443 → nginx on `127.0.0.1:5173`).

One-time setup in the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS** → turn on **MagicDNS**, then **HTTPS Certificates**.
2. **Access controls** → allow Funnel for this node with the `funnel` nodeAttr, e.g.:
   ```json
   "nodeAttrs": [
     { "target": ["autogroup:member"], "attr": ["funnel"] }
   ]
   ```
   (Use a tag such as `tag:fortymm` as the target instead if the auth key is tagged.)
3. **Settings → Keys** → **Generate auth key**. Then `cp .env.example .env` and set `TS_AUTHKEY`. `.env` is gitignored;
   never commit the key. The key is only used on first login; the node is kept in the `tailscale-state` volume.

The public name can take a few minutes to start working the first time.
