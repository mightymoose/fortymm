#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
OUTPUT="$(mktemp -d)"
trap 'rm -rf "$OUTPUT"' EXIT
swiftc -swift-version 5 -parse-as-library -module-cache-path "$OUTPUT/cache" \
  "$ROOT/ios/Fortymm/MatchFlow/ScoreClearStore.swift" \
  "$ROOT/ios/Tests/ScoreClearTests.swift" -o "$OUTPUT/score-clear-tests"
"$OUTPUT/score-clear-tests"
