#!/bin/bash
# Reap worktrees whose PR has already merged.
#
# The tax this pays down: nothing in the workflow ever collected the garbage it
# created. `land-the-plane` Step 8 runs `gh pr merge --delete-branch`, which
# deletes the *branch* and never the *worktree* — so every shipped change left a
# ~270 MB tombstone behind. At the time this script was written that was 311
# worktrees / 82 GB, 236 of them (77%) on branches whose PR had long since
# merged, plus 439 local branches.
#
# That sprawl is not just disk. It is the root cause of a family of recurring
# failures: `/epic` resuming into a stale worktree whose branch was already
# squash-merged, ADR numbers computed by "increment the max" against a stale
# checkout, `gh pr merge --delete-branch` erroring out from inside a worktree,
# and QA stacks OOMing a host with no headroom left.
#
# SAFETY MODEL — this script deletes work, so it is paranoid by design:
#
#   * Dry run is the DEFAULT. Nothing is removed without `--force`.
#   * A worktree is only ever a candidate if its branch has a MERGED pull
#     request. Squash merges do not leave ancestry, so `--merged` /
#     `merge-base --is-ancestor` both under-report; the PR state is the only
#     honest signal. No PR, or a closed-unmerged PR, means KEEP.
#   * Even then it is only auto-reaped when nothing would be lost: no modified
#     tracked files, no unpushed commits beyond what the PR merged, and no
#     untracked file that looks like source rather than build junk.
#   * Anything merged-but-not-clean is reported as REVIEW and skipped, unless
#     you explicitly pass `--include-review`.
#   * The main checkout, the worktree you are standing in, and any worktree
#     git has marked `locked` are never touched.
#
# Usage:
#   scripts/reap-worktrees.sh                      # dry run: show what would go
#   scripts/reap-worktrees.sh --force              # reap the SAFE ones
#   scripts/reap-worktrees.sh --force --include-review
#   scripts/reap-worktrees.sh --docker             # also report docker residue
#   scripts/reap-worktrees.sh --force --docker     # ...and prune it
#
set -euo pipefail

FORCE=0
INCLUDE_REVIEW=0
DO_DOCKER=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force|-f)        FORCE=1 ;;
    --include-review)  INCLUDE_REVIEW=1 ;;
    --docker)          DO_DOCKER=1 ;;
    # Print the header block, stopping at the first non-comment line. A
    # hardcoded line range silently rots every time the header grows.
    -h|--help)         awk 'NR>1 && !/^#/{exit} NR>1{sub(/^# ?/,""); print}' "$0"; exit 0 ;;
    *) echo "unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# Capture the invoking worktree BEFORE we move — we must never reap the tree the
# caller is standing in.
CALLED_FROM="$(git rev-parse --show-toplevel 2>/dev/null || true)"

# Always operate from the MAIN checkout: `git worktree remove` must not be run
# from inside the worktree being removed, and a relative path would resolve
# against whichever worktree invoked us.
#
# `substr($0,10)` not `$2` — awk's $2 splits on whitespace, so a checkout path
# containing a space would be truncated to its first word. That matters more
# here than anywhere else in this script: MAIN_ROOT is what we `cd` into, and
# it is what every "is this the main checkout?" comparison below tests against.
# A truncated value makes those comparisons fail, which would make the main
# checkout itself look reapable.
MAIN_ROOT="$(git worktree list --porcelain | awk 'NR==1{print substr($0,10)}')"
cd "$MAIN_ROOT"

command -v gh >/dev/null 2>&1 || { echo "gh CLI required (PR state is the only safe merge signal)" >&2; exit 1; }

echo "Fetching merged PR head refs..."
# One temp dir, one trap, registered once — so there is no ordering question
# about which temp files a given trap covers.
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
MERGED="$TMP/merged"; LOCKED="$TMP/locked"
# `headRefName<TAB>headRefOid` — the oid is the commit GitHub actually merged.
# Comparing the local branch tip to it is the only reliable "did I commit
# anything the PR never saw?" test: `git cherry` compares patch-ids, and a
# SQUASH merge collapses N commits into one, so every commit on every
# squash-merged branch reads as unmerged. That false positive is what makes the
# naive check useless here — this repo squash-merges everything.
#
# `--state merged` (not `--state all` filtered locally): the closed/open rows
# would be fetched over the same ~6 paginated round trips and then thrown away,
# and nothing below acts on them.
gh pr list --state merged --limit 2000 --json headRefName,headRefOid \
  -q '.[] | [.headRefName, .headRefOid] | @tsv' | sort -u > "$MERGED"
echo "  $(wc -l < "$MERGED" | tr -d ' ') merged head refs known"
echo

# An untracked path is "junk" if it is build output / tooling residue. Anything
# else is treated as possible work and forces REVIEW.
#
# This list is deliberately SHORT, because it is only the residue: the caller
# feeds us `git ls-files --others --exclude-standard`, which has already applied
# .gitignore, so node_modules/.venv/dist/.env/.DS_Store and friends never reach
# here from a current branch. What this covers is the stale-branch case — a
# worktree checked out from a commit whose .gitignore predates an entry — plus
# the few paths no .gitignore lists. Keep it minimal: a long list here is a
# second, divergent definition of "junk" governing a destructive decision.
is_junk() {
  case "$1" in
    .venv/*|*/.venv/*|.venv)              return 0 ;;   # api/.venv is the real one
    */.vite/*|*/xcshareddata/*)           return 0 ;;
    .qa-artifacts/*|.playwright-cli/*|*/.playwright-cli/*) return 0 ;;
    *) return 1 ;;
  esac
}

# Precompute the locked set once — a `locked` line follows its `worktree` line
# in the porcelain stream, so a single pass is both cheaper and less fragile
# than re-grepping with the path (which may contain regex metacharacters).
git worktree list --porcelain | awk '
  /^worktree /{ w=substr($0,10) }
  /^locked/   { print w }
' > "$LOCKED"

# Both arrays pack their fields into one string, TAB-separated, so nothing has to
# keep two parallel arrays in step. Tab (not `|`) because a `|` is legal in a git
# branch name while a control character is not — so the delimiter can never
# appear in the data. `safe` carries path+branch; `review` adds the reason.
safe=(); review=(); keep_n=0

while IFS= read -r line; do
  case "$line" in worktree\ *) wt="${line#worktree }" ;; *) continue ;; esac

  # Never the main checkout.
  [ "$wt" = "$MAIN_ROOT" ] && continue

  # Never the worktree we were invoked from.
  if [ -n "$CALLED_FROM" ] && [ "$wt" = "$CALLED_FROM" ]; then
    echo "SKIP  (current worktree)  $wt"; continue
  fi

  # Never a locked worktree — the lock is an explicit "leave this alone".
  if grep -qxF "$wt" "$LOCKED"; then
    echo "SKIP  (locked)           $wt"; continue
  fi

  branch="$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || true)"
  if [ -z "$branch" ]; then
    keep_n=$((keep_n+1)); continue          # detached HEAD: no PR to check against
  fi

  merged_oid="$(awk -F'\t' -v b="$branch" '$1==b{print $2; exit}' "$MERGED")"
  if [ -z "$merged_oid" ]; then
    keep_n=$((keep_n+1)); continue
  fi

  # --- merged: now decide whether anything would be lost -------------------
  why=""

  # 1. Modified/staged TRACKED files.
  if [ -n "$(git -C "$wt" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    why="modified tracked files"
  fi

  # 2. Untracked files that don't look like build junk.
  if [ -z "$why" ]; then
    # Read one MORE than the cap so truncation is detectable. A bounded scan
    # that silently stops is worse than no scan: the one path that can lose work
    # is a file we never looked at being classified SAFE and force-removed.
    n=0
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      n=$((n+1))
      if [ "$n" -gt 200 ]; then
        why="more than 200 untracked files — not audited, review by hand"; break
      fi
      if ! is_junk "$f"; then why="untracked: $f"; break; fi
    done < <(git -C "$wt" ls-files --others --exclude-standard 2>/dev/null | head -201)
  fi

  # 3. Commits made AFTER the PR merged — the only way a merged branch can still
  #    hold work. If the local tip is the exact commit GitHub merged, everything
  #    on this branch is in main by definition.
  if [ -z "$why" ]; then
    local_tip="$(git -C "$wt" rev-parse HEAD 2>/dev/null || true)"
    if [ -z "$local_tip" ]; then
      why="cannot resolve local HEAD"
    elif [ "$local_tip" != "$merged_oid" ]; then
      # The merged commit may not be in the local object DB at all (never
      # fetched, or gc'd). FAIL CLOSED: an unanswerable question is a REVIEW,
      # never a SAFE. Getting this backwards silently deletes real work.
      if ! git cat-file -e "${merged_oid}^{commit}" 2>/dev/null; then
        why="merged commit ${merged_oid:0:12} not in local object db — cannot prove nothing is lost"
      else
        # Tip differs but both are known. Only a problem if the tip carries
        # commits the merge never saw; a branch sitting *behind* its own merge
        # is fine (its content is a subset of what shipped).
        ahead="$(git -C "$wt" rev-list --count "${merged_oid}..${local_tip}" 2>/dev/null || echo unknown)"
        if [ "$ahead" = "unknown" ]; then
          why="cannot compare tip to merged commit"
        elif [ "$ahead" -gt 0 ]; then
          why="$ahead commit(s) added after the PR merged"
        fi
      fi
    fi
  fi

  if [ -n "$why" ]; then
    review+=("$wt	$branch	$why")
  else
    safe+=("$wt	$branch")
  fi
done < <(git worktree list --porcelain)

echo
echo "=========================================================="
echo "  SAFE to reap (PR merged, nothing to lose): ${#safe[@]}"
echo "  REVIEW (PR merged, but something is there): ${#review[@]}"
echo "  KEEP (no merged PR): $keep_n"
echo "=========================================================="

if [ "${#review[@]}" -gt 0 ]; then
  echo
  echo "REVIEW — not touched unless you pass --include-review:"
  # `${arr[@]+"${arr[@]}"}`: under `set -u`, macOS's bash 3.2 treats a plain
  # "${arr[@]}" on an EMPTY array as an unbound variable and aborts.
  for r in ${review[@]+"${review[@]}"}; do
    IFS=$'\t' read -r _ b w <<<"$r"; echo "    $b — $w"
  done
fi

# Recoverability: record branch -> sha -> path before anything is removed, so a
# reap can be undone with `git worktree add -b <branch> <path> <sha>`.
#
# Be honest about the shelf life. Because this repo SQUASH-merges, the recorded
# sha is NOT an ancestor of main (see the note on $MERGED), so once the branch is
# deleted its only local anchors are the reflog and gc's grace period. After that
# the commit is recoverable from the remote — `git fetch origin refs/pull/<N>/head`
# — but not from this clone. The content itself is never at risk: it is in main,
# squashed.
MANIFEST="${MAIN_ROOT}/.claude/reaped-worktrees.tsv"

reap_one() {
  local wt="$1" branch="$2"
  if [ "$FORCE" -eq 1 ]; then
    printf '%s\t%s\t%s\n' "$branch" "$(git -C "$wt" rev-parse HEAD 2>/dev/null || echo '?')" "$wt" \
      >> "$MANIFEST"
    git worktree remove --force "$wt" 2>/dev/null \
      || { echo "    ! could not remove $wt"; return; }
    # Branch is only deleted once its worktree is gone; -D because a
    # squash-merged branch never looks "merged" to git.
    git branch -D "$branch" >/dev/null 2>&1 || true
    echo "    reaped $branch"
  else
    echo "    would reap $branch  ($wt)"
  fi
}

echo
if [ "$FORCE" -eq 1 ]; then echo "Reaping..."; else echo "DRY RUN — nothing will be removed. Re-run with --force."; fi
for entry in ${safe[@]+"${safe[@]}"}; do
  IFS=$'\t' read -r wt_ br_ <<<"$entry"; reap_one "$wt_" "$br_"
done
if [ "$INCLUDE_REVIEW" -eq 1 ]; then
  echo "  (--include-review)"
  for entry in ${review[@]+"${review[@]}"}; do
    IFS=$'\t' read -r wt_ br_ _ <<<"$entry"; reap_one "$wt_" "$br_"
  done
fi

if [ "$FORCE" -eq 1 ]; then
  git worktree prune
  echo
  echo "Local branches remaining: $(git branch | wc -l | tr -d ' ')"
fi

if [ "$DO_DOCKER" -eq 1 ]; then
  echo
  echo "=== docker residue ==="
  docker system df 2>/dev/null || { echo "docker unavailable"; exit 0; }
  if [ "$FORCE" -eq 1 ]; then
    echo "Pruning build cache and dangling images (images in use are untouched)..."
    docker builder prune -f >/dev/null 2>&1 || true
    docker image prune -f  >/dev/null 2>&1 || true
    echo "After:"; docker system df 2>/dev/null
  else
    echo "(dry run — pass --force to prune build cache + dangling images)"
  fi
fi
