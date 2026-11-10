# fortymm

## Getting started

You need [mise](https://mise.jdx.dev) and Docker. Everything else runs in a development Docker Compose stack.

```sh
mise trust        # once per checkout
mise run up       # start the web-client dev server and print its URL
mise run ports    # print the URL again later
mise run teardown # remove containers, volumes and images when done
```

`mise tasks` lists every task. `CLAUDE.md` describes each one.
