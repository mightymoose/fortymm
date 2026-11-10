# fortymm

## Getting started

The apps are `web-client/` (Vite + React) and `api/` (FastAPI and PostgreSQL; see `api/README.md`).

You need Docker. Everything else runs in a development Docker Compose stack, driven by [mise](https://mise.jdx.dev) through `./bin/mise`, which downloads a pinned mise into `.mise/` on first run.

```sh
./bin/mise run up        # start every app (web-client, api and its PostgreSQL) and print their URLs
./bin/mise run ports     # print the URLs again later
./bin/mise run teardown  # remove containers, volumes and images when done
```

Before pushing, run what CI runs:

```sh
./bin/mise run validate  # lint, typecheck, build and test every app (web-client's Playwright suite included)
./bin/mise run e2e       # end-to-end suites outside validate (pytest for api)
```

Tasks for one app are prefixed with its name, e.g. `./bin/mise run web-client:up` or `./bin/mise run web-client:lint`. `./bin/mise tasks` lists every task. `CLAUDE.md` describes each one.

To move to a newer mise, regenerate the script with `mise generate install-script --localize --write ./bin/mise`.
