#!/usr/bin/env bash
# check-workflows.sh [workflows directory]
#
# Fails if a workflow breaks the rules the previews' comment depends on
# (.github/workflows/ci.yml's header says why):
#
# 1. pull-requests: write is given to ci.yml's preview-comment job alone:
#    never at a workflow's top level, never to another job.
# 2. That job has no secrets, cannot sign in anywhere (no id-token), and never
#    checks out the pull request's code: a checkout, if any, is of the base
#    commit.
# 3. It never runs where the previews don't: it needs both previews and its
#    condition is theirs (with !cancelled(), so it also reports a preview that
#    failed). And it is no merge gate: ci-passed doesn't need it.
#
# Reads the YAML with yq, then checks it with jq. The workflows task runs it.
set -euo pipefail
dir=${1:-.github/workflows}
failures=0
fail() {
  echo "FAILED  $*"
  failures=$((failures + 1))
}

all=$(for f in "$dir"/*.yml "$dir"/*.yaml; do
  [ -e "$f" ] || continue
  yq -o=json '.' "$f" | jq --arg file "$(basename "$f")" '{file: $file, workflow: .}'
done | jq -s .)

# ---- 1. Who has pull-requests: write ------------------------------------------
# grants: true when a permissions value gives pull-requests write.
grants='def grants: . == "write-all" or (type == "object" and .["pull-requests"] == "write");'
top=$(jq -r "$grants"' .[] | select(.workflow.permissions | grants) | .file' <<<"$all")
[ -z "$top" ] || fail "pull-requests: write at the top level of: $top"
holders=$(jq -r "$grants"' .[] | .file as $f | .workflow.jobs | to_entries[]
  | select(.value.permissions | grants) | "\($f):\(.key)"' <<<"$all" | paste -sd' ' -)
[ "$holders" = "ci.yml:preview-comment" ] ||
  fail "pull-requests: write must be given to ci.yml:preview-comment alone; it is given to: '${holders}'"

# ---- 2. What the comment job may hold -------------------------------------------
ci=$(jq '.[] | select(.file == "ci.yml") | .workflow' <<<"$all")
job=$(jq '.jobs["preview-comment"] // empty' <<<"$ci")
if [ -z "$job" ]; then
  fail "ci.yml has no preview-comment job"
else
  jq -e 'tostring | test("secrets\\.|secrets\\[") | not' <<<"$job" >/dev/null ||
    fail "preview-comment uses a secret"
  jq -e '(.permissions | type == "object") and
    (.permissions | to_entries | all(.key == "pull-requests" and .value == "write"
      or .key == "contents" and .value == "read"))' <<<"$job" >/dev/null ||
    fail "preview-comment may hold pull-requests: write and contents: read, nothing more: $(jq -c .permissions <<<"$job")"
  jq -e '[.steps[]? | select(.uses // "" | startswith("actions/checkout@"))]
    | all(.with.ref == "${{ github.event.pull_request.base.sha }}")' <<<"$job" >/dev/null ||
    fail "preview-comment checks out something other than the base commit (the pull request's code?)"
fi

# ---- 3. Where it runs, and that nothing waits for it ------------------------------
norm='def norm: tostring | gsub("^\\s*\\$\\{\\{|\\}\\}\\s*$"; "") | gsub("\\s+"; " ") | ltrimstr(" ") | rtrimstr(" ");'
if [ -n "$job" ]; then
  jq -e "$norm"' (.jobs.preview.if | norm) == (.jobs["preview-api"].if | norm)' <<<"$ci" >/dev/null ||
    fail "the two previews' conditions differ, so the comment job can't share one"
  jq -e "$norm"' (.jobs["preview-comment"].if | norm) == "!cancelled() && " + (.jobs.preview.if | norm)' <<<"$ci" >/dev/null ||
    fail "preview-comment's condition is not the previews' (with !cancelled() &&): $(jq -r '.jobs["preview-comment"].if' <<<"$ci")"
  jq -e '.jobs["preview-comment"].needs | if type == "string" then [.] else . end
    | index("preview") != null and index("preview-api") != null' <<<"$ci" >/dev/null ||
    fail "preview-comment doesn't need both previews"
fi
waiters=$(jq -r '.[] | .file as $f | .workflow.jobs | to_entries[]
  | select(.value.needs // [] | if type == "string" then [.] else . end | index("preview-comment") != null)
  | "\($f):\(.key)"' <<<"$all" | paste -sd' ' -)
[ -z "$waiters" ] || fail "no job may need preview-comment (it is no merge gate); needed by: $waiters"

if [ "$failures" -gt 0 ]; then
  echo "check-workflows.sh: $failures rule(s) broken."
  exit 1
fi
echo "check-workflows.sh: only preview-comment has pull-requests: write; it has no secrets, no id-token and no checkout of the pull request; it runs only where the previews do; nothing needs it."
