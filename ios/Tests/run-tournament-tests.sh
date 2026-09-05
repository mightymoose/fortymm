#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$(mktemp -d)"
trap 'rm -rf "$OUTPUT"' EXIT
swiftc -swift-version 5 -parse-as-library -module-cache-path "$OUTPUT/cache" \
  "$ROOT"/Fortymm/Networking/*.swift \
  "$ROOT/Fortymm/Session/SessionModels.swift" \
  "$ROOT/Fortymm/MatchFlow/MatchAPI.swift" \
  "$ROOT/Fortymm/Tournaments/TournamentModels.swift" \
  "$ROOT/Fortymm/Tournaments/TournamentStore.swift" \
  "$ROOT/Tests/TournamentTests.swift" -o "$OUTPUT/tournament-tests"
"$OUTPUT/tournament-tests"
