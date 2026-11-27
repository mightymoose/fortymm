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

## Web client (Vite + React + TypeScript)

The app lives in `web-client/`. Node is installed in the image by mise from `web-client/mise.toml`; nothing runs on the host.

```sh
./bin/mise run web-client:dev                      # dev server on a random host port (URL printed at startup)
./bin/mise run web-client:npm -- install <pkg>     # any npm command in the container
./bin/mise run web-client:npm -- run build
./bin/mise run web-client:npm -- run lint
```

Each `web-client:dev` gets its own container and host port, so several can run at once. `./bin/mise run ports` lists them.
Dependencies are baked into the image; `web-client:dev` rebuilds it when `package.json` or the lockfile changes.

## Preview (Tailscale Funnel)

`./bin/mise run preview` starts everything. For now that's the dev server, behind a Tailscale sidecar that serves it
on the internet at `https://fortymm.<tailnet>.ts.net` via Funnel. No host ports are published; `web-client:dev` is unchanged.
The sidecar's config is `tailscale/serve.json` (Funnel on 443 → Vite on `127.0.0.1:5173`).

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
