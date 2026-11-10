#!/bin/sh
# Generates src/api/schema.gen.ts, the TypeScript types of the api's OpenAPI
# document (api/openapi.json, mounted read-only at /contracts/api/openapi.json).
#
# With --check, fails instead when the committed file differs from what the
# document generates, and leaves the regenerated file in place, so committing
# it fixes the check (like scripts/check-route-tree.sh).
#
# Runs in the web-client-openapi tool container: ./bin/mise run
# web-client:api-types, or web-client:api-types-check.
set -e

contract=/contracts/api/openapi.json
out=src/api/schema.gen.ts

before=/tmp/schema.gen.before.ts
if [ -f "$out" ]; then
  cp "$out" "$before"
else
  : >"$before"
fi

openapi-typescript "$contract" --output "$out"

if [ "$1" != "--check" ]; then
  exit 0
fi
if ! cmp -s "$before" "$out"; then
  diff -u "$before" "$out" || true
  echo >&2
  echo "$out was stale: it did not match api/openapi.json." >&2
  echo "It has now been regenerated. Commit the regenerated file." >&2
  exit 1
fi
echo "$out matches api/openapi.json."
