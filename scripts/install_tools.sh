#!/bin/bash
set -e

# --- Runs on LOCAL machines too (above the CLAUDE_CODE_REMOTE gate) --------
#
# Point git at the repo's checked-in hooks. Git deliberately never enables
# hooks from a clone, so `.githooks/pre-push` (the OpenAPI-drift guard) is inert
# until core.hooksPath is set. This is the local-side counterpart to
# check-main-freshness.sh: the thing it protects — a wasted 15-minute CI round
# trip on forgotten `mise run regen-api-types` — only ever bites locally, so it
# must run before the remote-only early exit below.
#
# Best-effort and non-fatal: `set -e` is in force, so every git call is guarded.
#
# WORKTREE NOTE: `git config` without `--worktree` writes to the SHARED
# `.git/config`, so running this from any one worktree enables the hooks for the
# main checkout and every other worktree at once — intended. The value stays
# RELATIVE because git resolves a relative core.hooksPath against the top level
# of the *current* working tree, so each worktree runs its own copy of the hook.
setup_git_hooks() {
  local root current
  root="$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ -d "$root/.githooks" ] || return 0

  current="$(git -C "$root" config --get core.hooksPath 2>/dev/null || true)"
  case "$current" in
    .githooks)
      return 0 ;;                       # already wired — idempotent no-op
    "" | .git/hooks | */.git/hooks)
      # Unset, or git's own default written out longhand: safe to take over.
      git -C "$root" config core.hooksPath .githooks 2>/dev/null \
        && echo "[hooks] core.hooksPath -> .githooks (repo hooks enabled)" \
        || true ;;
    *)
      echo "[hooks] core.hooksPath is '$current' (not ours) — leaving it alone." \
           "Run: git config core.hooksPath .githooks" ;;
  esac
}
setup_git_hooks || true

# Skip on local machines — you already have your own mise/asdf setup
if [ "$CLAUDE_CODE_REMOTE" != "true" ]; then
  exit 0
fi

# mise binary itself was installed by the env setup script and cached.
# This hook handles project-level tool installation that should track
# whatever mise.toml currently says, without needing to bust the cache.

cd "$CLAUDE_PROJECT_DIR"

# Trust the config (mise refuses to auto-install from untrusted files)
mise trust --yes

# Idempotent: skips anything already installed
mise install

# Persist mise's env into subsequent bash calls in this session.
# $CLAUDE_ENV_FILE is sourced by Claude Code before each Bash tool call.
mise env -s bash >> "$CLAUDE_ENV_FILE"

exit 0
