#!/usr/bin/env bash
# preview-comment.sh (tests)
#
# Claim: preview-comment.sh keeps one comment of addresses on a pull request.
# With no comment of its own it creates one; with its own marked comment it
# updates that one and creates none; a comment without the marker, or with
# the marker but by someone else, is left alone; a preview with no address is
# listed as "no preview was deployed". The body names the commit.
#
# Runs with a stand-in for gh (tests/stand-in/gh) first on PATH: nothing
# reaches GitHub. The workflows task runs it.
set -u
scripts=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$scripts/tests/stand-in:$PATH"
export STAND_IN_LOG STAND_IN_PAGES
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
STAND_IN_LOG=$work/log
failures=0

marker='<!-- fortymm:preview-addresses -->'
web=https://fortymm-pr-9.example.workers.dev
api=https://fortymm-api-pr-9-1.northamerica-northeast2.run.app

# page <file> <json array>: a page of comments, as GitHub lists them.
page() { printf '%s\n' "$2" >"$work/$1"; }
bot='"user": {"login": "github-actions[bot]"}'
person='"user": {"login": "someone"}'

# run_case <description> <expected requests, ';'-joined> <expected body lines...>
# with STAND_IN_PAGES, WEB_CLIENT_ADDRESS and API_ADDRESS set.
run_case() {
  local what=$1 want_requests=$2
  shift 2
  : >"$STAND_IN_LOG"
  out=$(REPO=mightymoose/fortymm PR=9 SHA=0123abc bash "$scripts/preview-comment.sh" 2>&1)
  status=$?
  requests=$(grep -E '^(POST|PATCH|PUT|DELETE) ' "$STAND_IN_LOG" | paste -sd';' -)
  problem=""
  [ "$status" = 0 ] || problem="exited $status"
  [ "$requests" = "$want_requests" ] || problem="$problem; requests: '$requests', expected '$want_requests'"
  for want in "$marker" "**Previews** of 0123abc:" "$@"; do
    grep -qxF -- "$want" "$STAND_IN_LOG" || problem="$problem; the body has no line '$want'"
  done
  if [ -n "$problem" ]; then
    echo "FAILED  $what: ${problem#; }"
    while IFS= read -r line; do echo "          $line"; done <<<"$out
$(cat "$STAND_IN_LOG")"
    failures=$((failures + 1))
  else
    echo "ok      $what"
  fi
}

export WEB_CLIENT_ADDRESS=$web API_ADDRESS=$api

page empty.json '[]'
STAND_IN_PAGES="$work/empty.json" \
  run_case "no comment yet: one is created, with both addresses" \
  "POST repos/mightymoose/fortymm/issues/9/comments" "- Web client: $web" "- API: $api"

page first.json "[{\"id\": 1, $person, \"body\": \"Looks good\"}]"
page second.json "[{\"id\": 42, $bot, \"body\": \"$marker\\n**Previews** of 9999999:\"}]"
STAND_IN_PAGES="$work/first.json $work/second.json" \
  run_case "its own marked comment, on the second page: that one is updated, none created" \
  "PATCH repos/mightymoose/fortymm/issues/comments/42" "- Web client: $web" "- API: $api"

page others.json "[{\"id\": 7, $bot, \"body\": \"Some other bot message\"},
  {\"id\": 8, $person, \"body\": \"$marker quoted by a person\"}]"
STAND_IN_PAGES="$work/others.json" \
  run_case "a comment without the marker, and a marked one by someone else: both left alone, one created" \
  "POST repos/mightymoose/fortymm/issues/9/comments"

WEB_CLIENT_ADDRESS="" STAND_IN_PAGES="$work/empty.json" \
  run_case "no web client address: it says no preview was deployed for the web client only" \
  "POST repos/mightymoose/fortymm/issues/9/comments" "- Web client: no preview was deployed" "- API: $api"

API_ADDRESS="" STAND_IN_PAGES="$work/empty.json" \
  run_case "no api address: it says no preview was deployed for the api only" \
  "POST repos/mightymoose/fortymm/issues/9/comments" "- Web client: $web" "- API: no preview was deployed"

if [ "$failures" -gt 0 ]; then
  echo "tests/preview-comment.sh: $failures case(s) failed."
  exit 1
fi
echo "tests/preview-comment.sh: one marked comment per pull request, created once and then updated; other comments untouched; a missing address reads 'no preview was deployed'."
