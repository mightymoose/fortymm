#!/bin/sh
# Make the venv volume match uv.lock exactly (a no-op when it already does),
# then run the given command. --frozen never rewrites the lockfile;
# api:lock-check catches a lockfile that is behind pyproject.toml.
set -e
if [ -f uv.lock ]; then
  uv sync --frozen --quiet
fi
exec "$@"
