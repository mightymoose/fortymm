#!/bin/sh
# api:install. With no arguments, update uv.lock to match pyproject.toml and
# install it. With arguments, add packages: dev-install fastapi-pagination,
# dev-install --dev pytest-xdist.
set -e
if [ "$#" -gt 0 ]; then
  exec uv add "$@"
fi
exec uv sync
