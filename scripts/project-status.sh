#!/usr/bin/env bash
#
# Move FortyMM project-board cards to a Status column.
#
#   scripts/project-status.sh "In Progress" 933 959
#   scripts/project-status.sh "Done" 933
#
# Resolves the project node id, the Status field, and the target option by NAME
# (so it survives option renames/reorders), then sets each issue's card. Requires
# `gh` authenticated with the `project` scope. Idempotent; an issue that isn't on
# the board is warned about and skipped rather than failing the batch.
set -euo pipefail

OWNER=mightymoose
PROJECT_NUMBER=8

STATUS="${1:-}"
shift || true
if [ -z "${STATUS}" ] || [ "$#" -eq 0 ]; then
  echo "usage: $(basename "$0") <status-name> <issue-number> [<issue-number> ...]" >&2
  exit 2
fi

project_json=$(gh project view "$PROJECT_NUMBER" --owner "$OWNER" --format json)
fields_json=$(gh project field-list "$PROJECT_NUMBER" --owner "$OWNER" --format json)
items_json=$(gh project item-list "$PROJECT_NUMBER" --owner "$OWNER" --limit 500 --format json)

# Resolve ids and map each requested issue -> its card id, in one python pass.
plan=$(
  STATUS="$STATUS" \
  PROJECT_JSON="$project_json" FIELDS_JSON="$fields_json" ITEMS_JSON="$items_json" \
  python3 - "$@" <<'PY'
import json, os, sys

status = os.environ["STATUS"]
project = json.loads(os.environ["PROJECT_JSON"])
fields = json.loads(os.environ["FIELDS_JSON"])["fields"]
items = json.loads(os.environ["ITEMS_JSON"])["items"]

field = next((f for f in fields if f.get("name") == "Status"), None)
if not field:
    sys.exit("no Status field on project")
option = next((o for o in field.get("options", []) if o["name"] == status), None)
if not option:
    names = ", ".join(repr(o["name"]) for o in field.get("options", []))
    sys.exit(f"no Status option named {status!r} (have: {names})")

by_number = {it.get("content", {}).get("number"): it["id"] for it in items}

print("META", project["id"], field["id"], option["id"])
for arg in sys.argv[1:]:
    try:
        num = int(arg.lstrip("#"))
    except ValueError:
        print("SKIP", arg, "not-a-number")
        continue
    item_id = by_number.get(num)
    print(("ITEM " + str(num) + " " + item_id) if item_id else ("MISSING " + str(num)))
PY
)

read -r _ project_id field_id option_id <<<"$(grep '^META ' <<<"$plan")"
rc=0

while read -r kind num item_id; do
  case "$kind" in
    ITEM)
      gh project item-edit --id "$item_id" --project-id "$project_id" \
        --field-id "$field_id" --single-select-option-id "$option_id" >/dev/null
      echo "→ #$num set to \"$STATUS\""
      ;;
    MISSING)
      echo "⚠ #$num is not on project $PROJECT_NUMBER — skipped" >&2
      rc=1
      ;;
    SKIP)
      echo "⚠ ignored argument '$num' ($item_id)" >&2
      ;;
  esac
done < <(grep -v '^META ' <<<"$plan")

exit $rc
