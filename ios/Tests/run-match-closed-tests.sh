#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$(mktemp -d)"
trap 'rm -rf "$OUTPUT"' EXIT
swiftc -swift-version 5 -parse-as-library -module-cache-path "$OUTPUT/cache" \
  "$ROOT"/ios/Fortymm/Networking/*.swift \
  "$ROOT/ios/Fortymm/Session/SessionModels.swift" \
  "$ROOT/ios/Fortymm/MatchFlow/MatchAPI.swift" \
  "$ROOT/ios/Fortymm/MatchFlow/MatchModels.swift" \
  "$ROOT/ios/Fortymm/MatchFlow/MatchService.swift" \
  "$ROOT/ios/Fortymm/Components/String+Initials.swift" \
  "$ROOT/ios/Fortymm/Tokens/Color+Tokens.swift" \
  "$ROOT/ios/Fortymm/MatchFlow/ScoreClearStore.swift" \
  "$ROOT/ios/Tests/MatchClosedTests.swift" -o "$OUTPUT/match-closed-tests"
"$OUTPUT/match-closed-tests"
