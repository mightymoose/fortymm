#!/bin/sh
# Fails when src/routeTree.gen.ts disagrees with the files in src/routes.
#
# Regenerates the tree with `tsr generate` (the same generator, with the same
# default options, as the Vite plugin) and compares it with the file as it was.
# On a mismatch the regenerated file is left in place, so committing it fixes
# the check. Run it with ./bin/mise run web-client:routes-check.
set -e

before=/tmp/routeTree.gen.before.ts
if [ -f src/routeTree.gen.ts ]; then
  cp src/routeTree.gen.ts "$before"
else
  : >"$before"
fi

npx tsr generate

if ! cmp -s "$before" src/routeTree.gen.ts; then
  diff -u "$before" src/routeTree.gen.ts || true
  echo >&2
  echo "src/routeTree.gen.ts was stale: it did not match the files in src/routes." >&2
  echo "It has now been regenerated. Commit the regenerated file." >&2
  exit 1
fi
echo "src/routeTree.gen.ts matches the files in src/routes."
