#!/bin/bash
# SessionStart freshness check.
#
# The tax this pays down: a session launched from a checkout whose local default
# branch is behind origin silently runs a stale set of .claude/skills and
# .claude/agents — they register at *launch*, so pulling mid-session doesn't help
# (you must restart). We hit exactly this when PR #853 (the /to-chores + domain
# -expert agents) had merged to origin/main but the local checkout was 9 commits
# behind, so the session couldn't see the very tools it needed.
#
# This runs on LOCAL (unlike install_tools.sh, which skips local) because that's
# where the staleness bites. It only ever WARNS — never blocks the session, never
# mutates anything. stdout on a SessionStart hook is added to the model's context,
# so Claude relays the warning in its first reply.
#
# Best-effort and bounded: a debounced, time-limited single-branch fetch. If the
# network is down or slow it gives up quietly and compares against the last-known
# remote ref.

set -u

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0
git rev-parse --git-dir >/dev/null 2>&1 || exit 0  # not a git repo → nothing to do

# Default branch (usually main); fall back to main if origin/HEAD isn't set.
default_branch="$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null | sed 's@^origin/@@')"
default_branch="${default_branch:-main}"

local_ref="refs/heads/${default_branch}"
remote_ref="refs/remotes/origin/${default_branch}"
git show-ref --verify --quiet "$local_ref" || exit 0  # no local default branch to compare

# Debounce: only fetch if we haven't in the last 10 minutes (SessionStart also
# fires on every resume — don't hit the network each time).
fetch_head="$(git rev-parse --git-path FETCH_HEAD 2>/dev/null)"
now="$(date +%s)"
last=0
if [ -f "$fetch_head" ]; then
  last="$(stat -f %m "$fetch_head" 2>/dev/null || stat -c %Y "$fetch_head" 2>/dev/null || echo 0)"
fi

if [ "$((now - last))" -gt 600 ]; then
  # Bound the fetch so a dead network can't hang the session. There's no
  # `timeout` binary on macOS, so cap the transport instead: ConnectTimeout for
  # ssh remotes (this repo's), low-speed limits for http. BatchMode keeps ssh
  # from ever blocking on a prompt. Best-effort — failure is swallowed.
  GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o ConnectTimeout=8 -o BatchMode=yes" \
    GIT_HTTP_LOW_SPEED_LIMIT=1000 GIT_HTTP_LOW_SPEED_TIME=8 \
    git fetch --quiet origin "$default_branch" 2>/dev/null || true
fi

git show-ref --verify --quiet "$remote_ref" || exit 0  # never fetched this remote → skip

behind="$(git rev-list --count "${local_ref}..${remote_ref}" 2>/dev/null || echo 0)"
[ "${behind:-0}" -eq 0 ] && exit 0  # up to date (or ahead) → silent

# The fast-forward must happen in whatever working tree has the default branch
# checked out (a worktree on a feature branch can't ff `main`). Find it; fall
# back to the current dir if the branch isn't checked out anywhere.
target="$(git worktree list --porcelain 2>/dev/null \
  | awk -v b="refs/heads/${default_branch}" '/^worktree /{p=$2} /^branch /{if ($2==b) print p}' \
  | head -1)"
target="${target:-$(pwd)}"

# Did the launch-registered surfaces (skills/agents) change upstream? That's the
# case worth shouting about, because a plain `git pull` won't fix this session.
surfaces_note=""
if ! git diff --quiet "$local_ref" "$remote_ref" -- .claude/skills .claude/agents 2>/dev/null; then
  surfaces_note="
   This includes .claude/skills and/or .claude/agents, which register at LAUNCH —
   so this session may be running a stale set. A pull alone won't fix it; restart
   the session after fast-forwarding."
fi

cat <<MSG
[freshness] Local '${default_branch}' is ${behind} commit(s) behind origin/${default_branch}.${surfaces_note}
   Fast-forward when convenient:
     git -C "${target}" merge --ff-only origin/${default_branch}
MSG
exit 0
