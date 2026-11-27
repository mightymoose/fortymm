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
