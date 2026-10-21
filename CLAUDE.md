# CLAUDE.md

Dev tools run inside a Docker Compose container managed by mise. Use the repo's
bootstrap wrapper `./bin/mise` (it downloads the pinned mise on first use); a
global `mise` install isn't required.

## Say hello

```sh
./bin/mise run hello
```

Builds the dev image if needed, installs Node (pinned in `mise.container.toml`)
inside the container, and prints `Hello World`.
