#!/bin/sh
# Install the suite's dependencies into the venv volume, updating
# e2e/api/uv.lock first if pyproject.toml changed (as npm install does for the
# web-client suite), then run the given command. A no-op when already in sync.
set -e
uv sync --quiet
exec "$@"
