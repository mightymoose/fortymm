#!/usr/bin/env bash
# Reject NEW ADRs that don't use the date-prefixed naming scheme.
#
# docs/adr/ carries three historical numbering schemes — sequential (0001-0018),
# issue-number (0783, 0915, 1001) and date (20260716+) — and ten duplicated
# numeric prefixes, including FOUR different `0008-*.md` files. Cause: parallel
# worktrees each number off a `main` that has already moved on, so two branches
# pick the same "next" number and both land. `YYYYMMDD-slug.md` cannot collide
# that way, because the date is assigned by the calendar rather than raced for.
#
# This check deliberately looks ONLY at files a branch *adds* relative to its
# base. The legacy names are grandfathered forever — their numbers are cited
# from PR bodies and commit messages, so renaming them would break those links.
# It therefore passes against the repo exactly as it stands today.
#
# Usage: scripts/check-adr-numbering.sh [base-ref]     (default: origin/main)

set -euo pipefail

base="${1:-origin/main}"
adr_dir="docs/adr"

cd "$(git rev-parse --show-toplevel)"

if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "check-adr-numbering: base ref '$base' not found — skipping." >&2
  exit 0
fi

# Three-dot: compare against the merge base, so unrelated ADRs that landed on
# main after this branch was cut don't read as "added by this branch".
# --diff-filter=A: additions only. A push straight to main degenerates to an
# empty range, which passes.
added="$(git diff --name-only --diff-filter=A "$base...HEAD" -- "$adr_dir" || true)"

bad=""
while IFS= read -r path; do
  [ -n "$path" ] || continue
  name="${path#"$adr_dir"/}"

  # Directory furniture, not a decision record.
  case "$name" in
    README.md) continue ;;
  esac

  # YYYYMMDD-lower-hyphen-slug.md, with a sane-looking date.
  if [[ "$name" =~ ^(20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])-[a-z0-9]+(-[a-z0-9]+)*\.md$ ]]; then
    continue
  fi

  bad="$bad$path
"
done <<EOF
$added
EOF

if [ -z "$bad" ]; then
  exit 0
fi

{
  echo "::error::New ADRs must be named docs/adr/YYYYMMDD-slug.md"
  echo
  echo "These added files don't match the date-prefixed scheme:"
  printf '%s' "$bad" | sed 's/^/  - /'
  echo
  echo "Rename them, e.g.:"
  echo "    git mv $adr_dir/<file> $adr_dir/$(date -u +%Y%m%d)-<lowercase-hyphenated-decision>.md"
  echo
  echo "Why: sequential numbering raced across worktrees and produced ten"
  echo "duplicated prefixes (four different 0008-*.md). A calendar date can't"
  echo "collide that way. Existing ADRs keep their legacy names on purpose —"
  echo "this check only ever inspects files your branch ADDS."
  echo "See $adr_dir/README.md."
} >&2
exit 1
