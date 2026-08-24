#!/usr/bin/env bash
#
# Move FortyMM project-board cards (the live board, project 9) to a Status column.
#
#   scripts/project-status.sh "In Progress" 933 959
#   scripts/project-status.sh --dry-run "Done" 933
#
# Targets project 9 by default. Override with FORTYMM_PROJECT_NUMBER, but the
# script refuses to write a project whose `closed` field is true — that guard is
# what stops this from silently writing an archived board again, the way it once
# wrote the closed project 8 while reporting success.
#
# Resolves the project id, the Status field, and the target option by NAME (so it
# survives option renames/reorders); hardcodes no field id or option id. Resolves
# each issue's OWN card with the single-issue `repository.issue.projectItems`
# GraphQL query, never `gh project item-list` — that call lists the whole board and
# costs roughly 99 GraphQL points against the shared 5000/hr budget, versus about 1
# point per issue here (see .claude/rules/the-review-gate.md). An issue that sits on
# more than one project board resolves to the target project's own card, never the
# first one returned.
#
# After every write, reads the card's Status back and confirms it matches before
# reporting success; a write that did not stick is a failure, not a success.
#
# --dry-run resolves the project, the option and every card, and prints the change
# each issue would get, but performs no write.
#
# Requires `gh` authenticated with the `project` scope. Idempotent. An issue that
# isn't on the target board is warned about (naming the project number) and the
# batch continues, but the run exits non-zero — a batch with some successes and
# some misses still writes every card it can, then reports failure.
set -euo pipefail

OWNER=mightymoose
REPO=fortymm
PROJECT_NUMBER="${FORTYMM_PROJECT_NUMBER:-9}"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

STATUS="${1:-}"
shift || true
if [ -z "${STATUS}" ] || [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") [--dry-run] <status-name> <issue-number> [<issue-number> ...]" >&2
  exit 2
fi

auth_status=$(gh auth status 2>&1) || true
if ! grep -q "'project'" <<<"$auth_status"; then
  echo "gh is not authenticated with the 'project' scope — run: gh auth refresh -s project" >&2
  exit 1
fi

project_json=$(gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json)

is_closed=$(python3 -c 'import json,sys; print("true" if json.load(sys.stdin).get("closed") else "false")' <<<"$project_json")
if [ "$is_closed" = "true" ]; then
  echo "project $PROJECT_NUMBER ($OWNER) is closed — refusing to write it" >&2
  exit 1
fi
project_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])' <<<"$project_json")

fields_json=$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json)

resolved=$(
  STATUS="$STATUS" FIELDS_JSON="$fields_json" python3 - <<'PY'
import json, os, sys

status = os.environ["STATUS"]
fields = json.loads(os.environ["FIELDS_JSON"])["fields"]

field = next((f for f in fields if f.get("name") == "Status"), None)
if not field:
    sys.exit("no Status field on project")
option = next((o for o in field.get("options", []) if o["name"] == status), None)
if not option:
    names = ", ".join(repr(o["name"]) for o in field.get("options", []))
    sys.exit(f"no Status option named {status!r} (have: {names})")

print(field["id"])
print(option["id"])
PY
)
field_id=$(sed -n '1p' <<<"$resolved")
option_id=$(sed -n '2p' <<<"$resolved")

ITEM_QUERY='
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      projectItems(first: 20) {
        nodes {
          id
          project { number }
          fieldValueByName(name: "Status") {
            ... on ProjectV2ItemFieldSingleSelectValue { name }
          }
        }
      }
    }
  }
}'

# Resolve one issue's OWN card on $PROJECT_NUMBER. Prints "<item-id>|<status-name>"
# (status-name may be empty) on a match, an empty line if the issue isn't on this
# project, and returns non-zero only if the query itself failed.
resolve_card() {
  local num="$1" json
  json=$(gh api graphql -f query="$ITEM_QUERY" -F owner="$OWNER" -F repo="$REPO" -F number="$num") || return 1
  PROJECT_NUMBER="$PROJECT_NUMBER" python3 -c '
import json, os, sys

data = json.load(sys.stdin)
target = int(os.environ["PROJECT_NUMBER"])
issue = (data.get("data") or {}).get("repository", {}).get("issue")
nodes = issue["projectItems"]["nodes"] if issue else []
for n in nodes:
    if n["project"]["number"] == target:
        fv = n.get("fieldValueByName")
        print(n["id"] + "|" + (fv["name"] if fv else ""))
        sys.exit(0)
print("")
' <<<"$json"
}

rc=0

for arg in "$@"; do
  if ! [[ "$arg" =~ ^\#?[0-9]+$ ]]; then
    echo "⚠ ignored argument '$arg' (not a number)" >&2
    continue
  fi
  num="${arg#\#}"

  if ! card=$(resolve_card "$num"); then
    echo "⚠ #$num: could not query project $PROJECT_NUMBER for this issue" >&2
    rc=1
    continue
  fi
  if [ -z "$card" ]; then
    echo "⚠ #$num is not on project $PROJECT_NUMBER — skipped" >&2
    rc=1
    continue
  fi
  item_id="${card%%|*}"
  current_status="${card#*|}"

  if [ "$DRY_RUN" = "1" ]; then
    echo "→ #$num: \"$current_status\" → \"$STATUS\" (dry run)"
    continue
  fi

  if ! gh project item-edit --id "$item_id" --project-id "$project_id" \
      --field-id "$field_id" --single-select-option-id "$option_id" >/dev/null; then
    echo "⚠ #$num: write failed" >&2
    rc=1
    continue
  fi

  if ! verify=$(resolve_card "$num"); then
    echo "⚠ #$num: wrote the card but could not read it back to confirm" >&2
    rc=1
    continue
  fi
  verify_status="${verify#*|}"
  if [ "$verify_status" != "$STATUS" ]; then
    echo "⚠ #$num: write did not stick (read back \"$verify_status\")" >&2
    rc=1
    continue
  fi

  echo "→ #$num set to \"$STATUS\""
done

exit $rc
