#!/bin/bash
set -e

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
