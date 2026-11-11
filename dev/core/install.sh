#!/bin/sh
# core:install. With no arguments, update Cargo.lock to match the Cargo.toml
# files, changing as little as possible. With arguments, add packages:
# dev-install sha2, dev-install --dev hex.
set -e
if [ "$#" -gt 0 ]; then
  exec cargo add "$@"
fi
exec cargo update --workspace
