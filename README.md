# fortymm

## Getting started

You need Docker. Everything else runs in a development Docker Compose stack, driven by [mise](https://mise.jdx.dev) through `./bin/mise`, which downloads a pinned mise into `.mise/` on first run.

```sh
./bin/mise run up       # start the web-client dev server and print its URL
./bin/mise run ports    # print the URL again later
./bin/mise run teardown # remove containers, volumes and images when done
```

`./bin/mise tasks` lists every task. `CLAUDE.md` describes each one.

To move to a newer mise, regenerate the script with `mise generate install-script --localize --write ./bin/mise`.
