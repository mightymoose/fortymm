#!/usr/bin/env bash
# Tear down a QA stack and reclaim the disk it leaves behind. Run from
# anywhere — the script cd's to the repo root.
#
# Usage:
#   scripts/qa-down.sh [ID] [--all] [--prune-cache] [--dry-run]
#
# ID names the stack (docker project `fortymm-qa-<ID>`, default: current git
# branch, sanitized) — the same derivation qa-up.sh uses, so IDs round-trip
# between up and down. Removes that stack's containers, network, named AND
# anonymous volumes, the images compose built for it, and the headless Chrome
# instances /qa-review spawned to drive it.
#
#   --all          tear down every fortymm-qa-* project docker knows about
#   --prune-cache  ALSO `docker builder prune -a -f` — global, not per-project
#   --dry-run      list what would be removed, remove nothing
#
# `down -v` alone is not enough: it leaves the locally-built images and the
# buildx cache. In the incident this script exists to prevent, a 230GB
# Docker.raw held 703 images (146GB) and 855 build-cache records (76.5GB);
# --prune-cache is the single biggest reclaim, at the cost of the next
# build being cold for every stack on this machine.
#
# Nor are containers the only thing a QA session leaks. The browser layer has
# the same disease: orphaned automation Chromes outlive the stack they were
# driving and spin forever. Live example — 12 of them at 90-95% CPU each drove
# load average to 51.7 on 24 cores; ten had been orphaned 7-18 days. So a
# teardown also reaps this stack's `/tmp/qa-chrome-<PROJECT>-<ROLE>` browsers,
# and --all additionally sweeps every /tmp/qa-chrome-* and every stray
# playwright_chromiumdev_profile-* Chrome (those carry no stack identity, so
# they are only safe to reap when you have asked for everything).
#
# Two things are off limits, always:
#   - UAT. k3d-* and fortymm-uat* resources are skipped explicitly, and nothing
#     here runs a blanket `docker volume prune` / `system prune` (either would
#     silently eat the unattached fortymm-uat_postgres-data volume).
#   - Your real browser. A process is killable ONLY if its --user-data-dir is
#     under /tmp/qa-chrome- or is a playwright_chromiumdev_profile. The real
#     profile (~/Library/Application Support/Google/Chrome) can never match,
#     and there is no `pkill -f "Google Chrome"` anywhere in this file.
#
# List stacks:  docker compose ls -a | grep fortymm-qa

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

COMPOSE_FILE="docker-compose.qa.yml"

usage() {
  # Reprint this file's header comment block (everything after the shebang, up
  # to the first blank/non-comment line) so --help can't drift from the docs.
  awk 'NR>1 { if (/^#/) { sub(/^# ?/, ""); print } else { exit } }' "$0"
}

# --- args ------------------------------------------------------------------
ALL=0
PRUNE_CACHE=0
DRY_RUN=0
ID_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --all)         ALL=1 ;;
    --prune-cache) PRUNE_CACHE=1 ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)     usage; exit 0 ;;
    -*)            echo "ERROR: unknown option: $1" >&2; echo >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$ID_ARG" ]; then
        echo "ERROR: at most one ID may be given (got '$ID_ARG' and '$1')" >&2; exit 2
      fi
      ID_ARG="$1"
      ;;
  esac
  shift
done

if [ "$ALL" -eq 1 ] && [ -n "$ID_ARG" ]; then
  echo "ERROR: --all tears down every fortymm-qa-* stack; don't also pass an ID ('$ID_ARG')" >&2
  exit 2
fi

# --- UAT guard -------------------------------------------------------------
# The k3d UAT cluster shares this docker daemon. `fortymm-uat_postgres-data`
# is attached to no container (k3d mounts it inside the cluster), so it looks
# "dangling" to docker — a blanket `docker volume prune` WOULD delete it,
# taking the real UAT database and the k3d tailscale-state Secrets (whose loss
# renames the tailnet nodes) with it. Hence: no blanket prunes anywhere in
# this script, and every single removal is allowlisted to fortymm-qa-* first
# and re-checked against this deny pattern immediately before it runs.
PROTECTED_RE='^(k3d-|fortymm-uat)'

is_protected() { [[ "$1" =~ $PROTECTED_RE ]]; }

# A teardown target must be the `fortymm-qa` project or a `fortymm-qa-<ID>`
# one. `fortymm-uat` / `k3d-*` can never match, but check anyway.
is_qa_project() {
  if is_protected "$1"; then return 1; fi
  [[ "$1" =~ ^fortymm-qa(-|$) ]]
}

# A volume is removable only if it is this project's named volume
# (`<project>_<name>`) or a 64-hex anonymous volume that we observed mounted
# into one of this project's containers. Nothing else is ever touched.
is_qa_volume() {
  local vol="$1" project="$2"
  if is_protected "$vol"; then return 1; fi
  case "$vol" in "${project}_"*) return 0 ;; esac
  [[ "$vol" =~ ^[0-9a-f]{64}$ ]]
}

# --- browser guard ---------------------------------------------------------
# THE most dangerous predicate in this file. It decides what gets SIGKILLed,
# and the user's real Chrome is running on this machine while it does.
#
# The safety argument rests on one choice: we never pattern-match the process
# name or a loose substring of the cmdline. We extract the --user-data-dir
# VALUE and require the whole value to be a known-disposable profile. A real
# Chrome's value is `/Users/<you>/Library/Application Support/Google/Chrome`,
# which cannot match either alternative below — so `pkill -f "Google Chrome"`,
# which would take your open tabs with it, is never needed and never used.
#
#   /tmp/qa-chrome-<PROJECT>-<ROLE>   spawned by /qa-review (poster/opponent/…)
#   …/T/playwright_chromiumdev_profile-XXXXXX   spawned by a Playwright run
DISPOSABLE_PROFILE_RE='^(/tmp/qa-chrome-|/.*/playwright_chromiumdev_profile-)'

is_disposable_profile() { [[ "$1" =~ $DISPOSABLE_PROFILE_RE ]]; }

# Second, independent condition: the process must actually BE a browser.
# Found the hard way — a plain `grep -F -- --user-data-dir=/tmp/qa-chrome-`
# carries a disposable-looking profile in its ARGUMENTS and was a kill target
# until this existed.
#
# Note this takes the EXECUTABLE, not the cmdline, and asks the kernel for it
# (`ps -o comm=`) rather than parsing it out of the front of the command
# string. Parsing cannot work: a browser's argv[0] contains spaces
# (".../Google Chrome Helper (Renderer)"), so there is no delimiter that
# separates program from arguments, and any prefix heuristic mistakes
# `nvim /tmp/qa-chrome-notes` for a browser.
is_browser_binary() {
  local pid="$1" comm
  comm="$(ps -p "$pid" -o comm= 2>/dev/null)" || return 1
  [ -n "$comm" ] || return 1
  # Playwright may run its own bundled build, whose executable is named
  # `headless_shell` rather than anything "chrom", so accept that too. This
  # only ever widens the set among processes that ALREADY hold a disposable
  # profile — a headless_shell on your real profile still cannot be reached.
  case "$comm" in
    *[Cc]hrom*|*headless_shell*|*/ms-playwright/*) return 0 ;;
  esac
  return 1
}

# `rm -rf` target validator. Only ever a single /tmp/qa-chrome-* directory
# whose name is boring: no slashes past the prefix, no `..`, nothing exotic.
is_removable_profile_dir() {
  case "$1" in
    */../*|*/..|*"
"*) return 1 ;;
  esac
  [[ "$1" =~ ^/tmp/qa-chrome-[A-Za-z0-9._-]+$ ]]
}

# Extract the --user-data-dir value from a cmdline. Paths we care about have
# no spaces; the real profile's DOES, so it truncates to
# `/Users/<you>/Library/Application` — which still fails the guard above.
# Truncating an untrusted value can only ever make it LESS matchable here,
# never more, because both alternatives are anchored prefixes.
profile_of_cmdline() {
  local cmd="$1" udd
  case "$cmd" in *--user-data-dir=*) ;; *) return 1 ;; esac
  udd="${cmd#*--user-data-dir=}"
  udd="${udd%% *}"
  [ -n "$udd" ] || return 1
  printf '%s' "$udd"
}

# Emit "<pid>\t<profile>" for every live process whose disposable profile also
# matches the ERE in $1. Callers pass a full-path anchored ERE, so one stack's
# teardown can never reach another stack's browser.
list_browsers() {
  local want="$1" pid rest udd
  while read -r pid rest; do
    [ -n "${pid:-}" ] || continue
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    [ "$pid" != "$$" ] || continue
    # Cheap pre-filter so we only fork a subshell for actual browsers, not for
    # all ~600 processes on the machine.
    case "$rest" in *--user-data-dir=*) ;; *) continue ;; esac
    udd="$(profile_of_cmdline "$rest")" || continue
    # Three independent conditions. The two cheap string checks run first so
    # the ps(1) fork in is_browser_binary only happens for real candidates.
    is_disposable_profile "$udd" || continue
    [[ "$udd" =~ $want ]] || continue
    is_browser_binary "$pid" || continue
    printf '%s\t%s\n' "$pid" "$udd"
  done < <(ps -ax -o pid=,command= 2>/dev/null || true)
}

BROWSERS_KILLED=0
PROFILE_DIRS_REMOVED=0
DRY_BROWSERS=0
DRY_PROFILE_DIRS=0
# A dry run reports the same target twice otherwise: once from its own stack's
# teardown, once from the --all orphan sweep. Nothing is killed, so nothing
# disappears from `ps` in between. Dedupe so the count means something.
DRY_SEEN=""

dry_seen() {
  case "$DRY_SEEN" in *" $1 "*) return 0 ;; esac
  DRY_SEEN="$DRY_SEEN $1 "
  return 1
}

# SIGTERM the matched browsers, then SIGKILL only the survivors.
kill_browsers() {
  local want="$1" label="$2"
  local -a pids=()
  local pid udd

  while IFS=$'\t' read -r pid udd; do
    [ -n "${pid:-}" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      dry_seen "pid:$pid" && continue
      echo "    DRY RUN — would kill $label browser pid $pid ($udd)"
      DRY_BROWSERS=$((DRY_BROWSERS + 1))
    else
      pids+=("$pid")
      echo "    killing $label browser pid $pid ($udd)"
    fi
  done < <(list_browsers "$want")

  [ "${#pids[@]}" -gt 0 ] || return 0

  for pid in "${pids[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
  sleep 2
  for pid in "${pids[@]}"; do
    if kill -0 "$pid" 2>/dev/null; then
      kill -KILL "$pid" 2>/dev/null || true
      echo "    SIGKILLed stubborn browser pid $pid"
    fi
  done
  BROWSERS_KILLED=$((BROWSERS_KILLED + ${#pids[@]}))
}

# Remove /tmp/qa-chrome-* profile dirs whose full path matches the ERE in $1.
remove_profile_dirs() {
  local want="$1" dir
  for dir in /tmp/qa-chrome-*; do
    [ -d "$dir" ] || continue
    [[ "$dir" =~ $want ]] || continue
    if ! is_removable_profile_dir "$dir"; then
      echo "    SKIP profile dir (failed the rm -rf validator): $dir"
      continue
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      dry_seen "dir:$dir" && continue
      echo "    DRY RUN — would remove profile dir: $dir"
      DRY_PROFILE_DIRS=$((DRY_PROFILE_DIRS + 1))
    elif rm -rf "$dir"; then
      echo "    removed profile dir: $dir"
      PROFILE_DIRS_REMOVED=$((PROFILE_DIRS_REMOVED + 1))
    else
      echo "    could not remove profile dir: $dir"
    fi
  done
}

# --- disk accounting -------------------------------------------------------
to_bytes() {
  local s num unit mult
  s="${1//[[:space:]]/}"
  num="${s%%[A-Za-z]*}"
  unit="${s#"$num"}"
  [ -n "$num" ] || { printf '0'; return 0; }
  case "$unit" in
    ""|B)   mult=1 ;;
    kB|KB)  mult=1000 ;;
    MB)     mult=1000000 ;;
    GB)     mult=1000000000 ;;
    TB)     mult=1000000000000 ;;
    KiB)    mult=1024 ;;
    MiB)    mult=1048576 ;;
    GiB)    mult=1073741824 ;;
    TiB)    mult=1099511627776 ;;
    *)      mult=1 ;;
  esac
  awk -v n="$num" -v m="$mult" 'BEGIN { printf "%.0f", n * m }'
}

human() {
  awk -v b="$1" 'BEGIN {
    sign = ""; if (b < 0) { sign = "-"; b = -b }
    split("B kB MB GB TB", u, " "); i = 1
    while (b >= 1000 && i < 5) { b /= 1000; i++ }
    printf "%s%.2f%s", sign, b, u[i]
  }'
}

# `docker system df` walks every layer and volume, so it can take minutes on a
# fat or busy daemon — 15+ minutes with no output, observed here while an
# unrelated build was running. Two consequences, both load-bearing:
#
#   1. Call it ONCE per snapshot and derive both the printed table and the byte
#      total from that one result — never twice.
#   2. Bound it, and degrade to "accounting unavailable" rather than hanging
#      the teardown. The machine that most needs this script is exactly the one
#      where df is slowest, and disk accounting is cosmetic — the reclaim is
#      not. macOS ships no timeout(1), so the wait is done by hand.
DF_TIMEOUT="${QA_DOWN_DF_TIMEOUT:-45}"

df_snapshot() {
  local out pid waited=0
  out="$(mktemp -t qa-down-df)"
  docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Size}}|{{.Reclaimable}}' >"$out" 2>/dev/null &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$waited" -ge "$DF_TIMEOUT" ]; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      rm -f "$out"
      return 0   # empty snapshot == unavailable; callers degrade gracefully
    fi
    sleep 1
    waited=$((waited + 1))
  done
  wait "$pid" 2>/dev/null || true
  cat "$out"
  rm -f "$out"
}

df_print() {
  if [ -z "$1" ]; then
    echo "    (docker system df did not answer within ${DF_TIMEOUT}s — skipping disk accounting."
    echo "     Raise it with QA_DOWN_DF_TIMEOUT=<seconds>; the teardown itself is unaffected.)"
    return 0
  fi
  printf '    %-15s %8s  %10s  %s\n' "TYPE" "COUNT" "SIZE" "RECLAIMABLE"
  while IFS='|' read -r type count size reclaimable; do
    [ -n "$type" ] || continue
    printf '    %-15s %8s  %10s  %s\n' "$type" "$count" "$size" "$reclaimable"
  done <<EOF
$1
EOF
}

df_total_bytes() {
  local total=0 type count size reclaimable
  while IFS='|' read -r type count size reclaimable; do
    [ -n "$size" ] || continue
    total=$((total + $(to_bytes "$size")))
  done <<EOF
$1
EOF
  printf '%s' "$total"
}

# --- enumeration (read-only) ----------------------------------------------
project_containers() {
  docker ps -a --filter "label=com.docker.compose.project=$1" --format '{{.Names}}' 2>/dev/null || true
}

# Named volumes carry the compose project label. Anonymous ones (created by the
# engine from an image's VOLUME directive) carry no labels at all, so they are
# discovered instead by inspecting the mounts of the project's own containers —
# which is also what keeps the removal attributable to this stack.
project_volumes() {
  local project="$1" ids
  docker volume ls -q --filter "label=com.docker.compose.project=$project" 2>/dev/null || true
  ids="$(docker ps -aq --filter "label=com.docker.compose.project=$project" 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker inspect $ids \
      --format '{{range .Mounts}}{{if eq .Type "volume"}}{{println .Name}}{{end}}{{end}}' 2>/dev/null || true
  fi
}

project_images() {
  docker images --filter "reference=$1-*" --format '{{.Repository}}:{{.Tag}} ({{.Size}})' 2>/dev/null || true
}

# --- teardown --------------------------------------------------------------
remove_volumes() {
  local project="$1"; shift
  local vol
  for vol in "$@"; do
    [ -n "$vol" ] || continue
    if ! is_qa_volume "$vol" "$project"; then
      echo "    SKIP volume (not this stack's): $vol"
      continue
    fi
    if docker volume inspect "$vol" >/dev/null 2>&1; then
      docker volume rm "$vol" >/dev/null 2>&1 \
        && echo "    removed leftover volume: $vol" \
        || echo "    could not remove volume (in use?): $vol"
    fi
  done
}

teardown_project() {
  local project="$1"
  local containers volumes images
  local -a vol_list=()

  if ! is_qa_project "$project"; then
    echo "==> SKIP (protected / not a fortymm-qa project): $project"
    return 0
  fi

  echo "==> Stack: $project"

  containers="$(project_containers "$project")"
  volumes="$(project_volumes "$project" | sed '/^$/d' | sort -u)"
  images="$(project_images "$project")"

  echo "    containers: ${containers:-(none)}" | tr '\n' ' '; echo
  echo "    volumes   : ${volumes:-(none)}" | tr '\n' ' '; echo
  echo "    images    : ${images:-(none)}" | tr '\n' ' '; echo

  if [ -n "$volumes" ]; then
    while IFS= read -r vol; do
      [ -n "$vol" ] && vol_list+=("$vol")
    done <<<"$volumes"
  fi

  # /qa-review names each browser profile /tmp/qa-chrome-<PROJECT>-<ROLE>, so
  # the compose project name we already derived IS the browser's identity.
  # Anchoring the ERE at both ends means tearing down `fortymm-qa-realtime`
  # cannot touch `fortymm-qa-realtime-dash`'s browsers: the leftover `-dash-
  # poster` has an interior dash, which `-[A-Za-z0-9]+$` refuses.
  local browser_re="^/tmp/qa-chrome-${project}(-[A-Za-z0-9]+)?$"

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    DRY RUN — would run: docker compose -p $project -f $COMPOSE_FILE down -v --remove-orphans --rmi local"
    local vol
    for vol in "${vol_list[@]:-}"; do
      [ -n "$vol" ] || continue
      if is_qa_volume "$vol" "$project"; then
        echo "    DRY RUN — would remove volume: $vol"
      else
        echo "    DRY RUN — SKIP protected/foreign volume: $vol"
      fi
    done
    kill_browsers "$browser_re" "this stack's"
    remove_profile_dirs "$browser_re"
    echo
    return 0
  fi

  # -v: named + anonymous volumes. --remove-orphans: containers from services
  # that have since left the compose file. --rmi local: the api/web-client/
  # worker/retirement-sweep images compose built for THIS project (they have no
  # `image:` key, so "local" is exactly them — never postgres/redis/nginx).
  docker compose -p "$project" -f "$COMPOSE_FILE" down -v --remove-orphans --rmi local

  # `down -v` misses anonymous volumes orphaned by earlier container
  # generations of this stack; sweep the ones we recorded above.
  remove_volumes "$project" "${vol_list[@]:-}"

  # The stack is gone; any browser still pointed at it is by definition an
  # orphan burning a core until someone notices.
  kill_browsers "$browser_re" "this stack's"
  remove_profile_dirs "$browser_re"
  echo
}

# --- which projects --------------------------------------------------------
list_qa_projects() {
  docker compose ls -a --format json 2>/dev/null \
    | tr ',' '\n' \
    | sed -n 's/.*"Name":"\([^"]*\)".*/\1/p' \
    | sort -u
}

declare -a PROJECTS=()

if [ "$ALL" -eq 1 ]; then
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    if is_qa_project "$name"; then
      PROJECTS+=("$name")
    else
      echo "==> skipping non-QA project: $name"
    fi
  done < <(list_qa_projects)
else
  # Stack ID: arg 1, else the sanitized current branch (identical to qa-up.sh).
  raw_id="${ID_ARG:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo qa)}"
  QA_ID="$(printf '%s' "$raw_id" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//; s/-*$//')"
  QA_ID="${QA_ID:-qa}"
  PROJECTS+=("fortymm-qa-${QA_ID}")
fi

echo "==> docker system df (before)"
BEFORE_DF="$(df_snapshot)"
df_print "$BEFORE_DF"
BEFORE_BYTES="$(df_total_bytes "$BEFORE_DF")"
echo

if [ "${#PROJECTS[@]}" -eq 0 ]; then
  echo "No fortymm-qa-* projects found — nothing to tear down."
else
  for project in "${PROJECTS[@]}"; do
    teardown_project "$project"
  done
fi

# In --all mode, also sweep QA leftovers whose compose project is already gone
# (e.g. the worktree that created it has been reaped). Both filters are
# name-scoped to fortymm-qa*, so k3d / fortymm-uat resources can never match.
if [ "$ALL" -eq 1 ]; then
  echo "==> Sweeping orphaned fortymm-qa* volumes and images"
  while IFS= read -r vol; do
    [ -n "$vol" ] || continue
    case "$vol" in fortymm-qa-*|fortymm-qa_*) ;; *) continue ;; esac
    if is_protected "$vol"; then
      echo "    SKIP protected volume: $vol"
      continue
    fi
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "    DRY RUN — would remove orphaned volume: $vol"
    else
      docker volume rm "$vol" >/dev/null 2>&1 \
        && echo "    removed orphaned volume: $vol" \
        || echo "    could not remove volume (in use?): $vol"
    fi
  done < <(docker volume ls -q 2>/dev/null || true)

  while IFS= read -r img; do
    [ -n "$img" ] || continue
    if [ "$DRY_RUN" -eq 1 ]; then
      echo "    DRY RUN — would remove orphaned image: $img"
    else
      docker rmi "$img" >/dev/null 2>&1 \
        && echo "    removed orphaned image: $img" \
        || echo "    could not remove image (in use?): $img"
    fi
  done < <(docker images --filter "reference=fortymm-qa-*" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null || true)
  echo

  # Browsers whose stack is long gone. A playwright_chromiumdev_profile carries
  # no stack identity at all — nothing in its path says which suite spawned it —
  # so it is only ever swept here, under an explicit --all, never as a side
  # effect of tearing down one stack. Both patterns still go through
  # is_disposable_profile, so the real Chrome remains unmatchable.
  echo "==> Sweeping orphaned test browsers (/tmp/qa-chrome-* and playwright_chromiumdev_profile-*)"
  kill_browsers '^/tmp/qa-chrome-' 'orphaned qa-review'
  kill_browsers '/playwright_chromiumdev_profile-' 'orphaned playwright'
  remove_profile_dirs '^/tmp/qa-chrome-'
  # Playwright profiles live in the OS temp dir, which macOS reaps on its own;
  # this script kills the processes but does not rm anything outside /tmp.
  echo
fi

# --- build cache (opt-in, global) ------------------------------------------
if [ "$PRUNE_CACHE" -eq 1 ]; then
  echo "==> Pruning the buildx build cache (GLOBAL — every project's next build is cold)"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "    DRY RUN — would run: docker builder prune -a -f"
    if [ -n "$BEFORE_DF" ]; then
      echo "    DRY RUN — build cache today: $(printf '%s\n' "$BEFORE_DF" \
        | awk -F'|' '$1 == "Build Cache" { printf "%s records, %s (%s reclaimable)", $2, $3, $4 }')"
    else
      echo "    DRY RUN — build cache size unknown (docker system df timed out)"
    fi
  else
    docker builder prune -a -f
  fi
  echo
else
  echo "==> Build cache left alone (re-run with --prune-cache to reclaim it — 76.5GB in the real incident)"
  echo
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Dry run — nothing was removed, so no 'after' snapshot was taken."
  [ -n "$BEFORE_DF" ] && echo "Before   : $(human "$BEFORE_BYTES") total in docker's four stores."
else
  echo "==> docker system df (after)"
  AFTER_DF="$(df_snapshot)"
  df_print "$AFTER_DF"
  AFTER_BYTES="$(df_total_bytes "$AFTER_DF")"
  echo

  if [ -n "$BEFORE_DF" ] && [ -n "$AFTER_DF" ]; then
    echo "Before   : $(human "$BEFORE_BYTES")"
    echo "After    : $(human "$AFTER_BYTES")"
    echo "Reclaimed: $(human "$((BEFORE_BYTES - AFTER_BYTES))")"
  else
    echo "Reclaimed: unknown (docker system df timed out; run it yourself once the daemon is idle)"
  fi
fi

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Browsers : $DRY_BROWSERS would be killed, $DRY_PROFILE_DIRS profile dirs would be removed"
else
  echo "Browsers : killed $BROWSERS_KILLED test browser(s), removed $PROFILE_DIRS_REMOVED stale profile dir(s)"
fi
echo
echo "UAT untouched by design: k3d-* containers/volumes and fortymm-uat_postgres-data are never removed here."
echo "Your real Chrome untouched by design: only /tmp/qa-chrome-* and playwright_chromiumdev_profile-* are killable."
