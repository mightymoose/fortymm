#!/usr/bin/env bash
# preview-comment.sh
#
# Puts a pull request's preview addresses on the pull request: one comment,
# found again on every run by a hidden marker and updated in place, or created
# if there is none. It lists the web client's preview and the api's, or "no
# preview was deployed" for one that wasn't, and says which commit it is for.
#
# CI's preview-comment job runs it (.github/workflows/ci.yml), with the
# addresses the preview jobs give as outputs. It needs gh, authenticated by the
# job's GITHUB_TOKEN with pull-requests: write, and jq; both are on GitHub's
# runners. Only the comment that has the marker and was written by
# github-actions[bot] (the GITHUB_TOKEN's user) is ever changed.
#
# Environment:
#   REPO                 owner/name
#   PR                   the pull request's number
#   SHA                  the commit the previews are of (the pull request's head)
#   WEB_CLIENT_ADDRESS   the web client's preview address, empty if none
#   API_ADDRESS          the api's preview address, empty if none
#   COMMENT_AUTHOR       whose comment to update (default github-actions[bot])
#
# .github/scripts/tests/preview-comment.sh tests it against a stand-in for gh.
set -euo pipefail

: "${REPO:?}" "${PR:?}" "${SHA:?}"
author=${COMMENT_AUTHOR:-github-actions[bot]}
marker='<!-- fortymm:preview-addresses -->'

case "$PR" in '' | *[!0-9]*)
  echo "preview-comment: PR must be a pull request's number, got '$PR'." >&2
  exit 2
  ;;
esac

line() { # <what> <address>
  if [ -n "$2" ]; then
    echo "- $1: $2"
  else
    echo "- $1: no preview was deployed"
  fi
}

body=$(mktemp)
trap 'rm -f "$body"' EXIT
{
  echo "$marker"
  echo "**Previews** of $SHA:"
  echo
  line "Web client" "${WEB_CLIENT_ADDRESS:-}"
  line "API" "${API_ADDRESS:-}"
  echo
  echo "_Updated on every push by CI's \`preview comment\` job._"
} >"$body"

# Every page of the pull request's comments; --paginate prints one JSON array
# per page, which jq -s joins.
existing=$(gh api --paginate "repos/$REPO/issues/$PR/comments" |
  jq -s --arg marker "$marker" --arg author "$author" -r '
    [add // [] | .[] | select(.user.login == $author and (.body | startswith($marker)))]
    | first | .id // empty')

if [ -n "$existing" ]; then
  gh api --method PATCH "repos/$REPO/issues/comments/$existing" -F "body=@$body" --jq .html_url
  echo "preview-comment: updated comment $existing."
else
  gh api --method POST "repos/$REPO/issues/$PR/comments" -F "body=@$body" --jq .html_url
  echo "preview-comment: created the comment."
fi
