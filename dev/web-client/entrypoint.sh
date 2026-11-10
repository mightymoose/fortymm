#!/bin/sh
# Install dependencies into the node_modules volume when it is empty or older
# than the lockfile, then run the given command.
set -e
if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  npm install --no-audit --no-fund
fi
exec "$@"
