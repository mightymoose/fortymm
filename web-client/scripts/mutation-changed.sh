#!/usr/bin/env bash
#
# Run StrykerJS against only the source files changed vs. a base ref.
#
# StrykerJS has NO built-in "changed files" / "--since" flag — scoping is done
# through `--mutate`. So we compute the changed set with git and pass it in.
# When nothing mutatable changed we exit 0 (not an error), which keeps this
# usable as a non-blocking PR check.
#
# Run from the web-client/ directory (the npm script and CI both do).
# Usage: scripts/mutation-changed.sh [base-ref]   (base-ref defaults to origin/main)
set -euo pipefail

base="${1:-origin/main}"

# Changed (Added/Copied/Modified/Renamed) .ts/.tsx files under src/, minus the
# same non-logic paths excluded by `mutate` in stryker.config.mjs: tests, page
# objects, factories, skeletons, vendored shadcn ui/, mocks, test setup, and
# generated files. git prints repo-root-relative paths; strip the web-client/
# prefix because Stryker runs from web-client/. `|| true` so an empty grep
# (no matches) doesn't trip `set -e`/`pipefail`.
changed=$(
  git diff --name-only --diff-filter=ACMR "${base}...HEAD" -- src \
    | grep -E '\.(ts|tsx)$' \
    | grep -vE '\.test\.|\.page\.tsx$|\.factory\.ts$|-skeleton\.tsx$|/components/ui/|/mocks/|/test/|\.gen\.ts$|schema\.d\.ts$' \
    | sed 's#^web-client/##' || true
)

if [ -z "${changed}" ]; then
  echo "No mutatable source files changed vs ${base} — skipping mutation run."
  exit 0
fi

echo "Mutating changed files vs ${base}:"
echo "${changed}" | sed 's/^/  /'

# paste -sd, joins lines with commas — portable on macOS bash 3.2 and Linux.
joined=$(echo "${changed}" | paste -sd, -)
exec npx stryker run --mutate "${joined}"
