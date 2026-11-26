# fortymm

## Requirements (Dafny)

Product requirements are written as Dafny specs in `requirements/*.dfy` and checked with Z3 in a container.
Dafny and Z3 are installed in the image by mise, using `bin/mise` and `requirements/mise.toml`.

```sh
./bin/mise run check-requirements                 # verify all requirements
./bin/mise run check-requirements Example.dfy     # verify specific files (relative to requirements/)
./bin/mise run dafny -- --help           # any other dafny command
docker compose build check-requirements       # after changing requirements/mise.toml
```

See `requirements/Example.dfy` for the pattern: requirements as predicates, a consistency witness,
and operations proven to preserve every requirement from every valid state.
