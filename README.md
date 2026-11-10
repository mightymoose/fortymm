# fortymm

## Getting started

You need Docker. Everything else runs in a development Docker Compose stack, driven by [mise](https://mise.jdx.dev) through `./bin/mise`, which downloads a pinned mise into `.mise/` on first run.

```sh
./bin/mise run up        # start every app and print their URLs
./bin/mise run ports     # print the URLs again later
./bin/mise run teardown  # remove containers, volumes and images when done
```

Tasks for one app are prefixed with its name, e.g. `./bin/mise run web-client:up` or `./bin/mise run web-client:lint`. `./bin/mise tasks` lists every task. `CLAUDE.md` describes each one.

To move to a newer mise, regenerate the script with `mise generate install-script --localize --write ./bin/mise`.
