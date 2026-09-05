#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$(mktemp -d)"
trap 'rm -rf "$OUTPUT"' EXIT
swiftc -swift-version 5 -parse-as-library -module-cache-path "$OUTPUT/cache" \
  "$ROOT"/Fortymm/Networking/*.swift \
  "$ROOT/Fortymm/Session/SessionModels.swift" \
  "$ROOT/Fortymm/Session/SessionStore.swift" \
  "$ROOT/Fortymm/Navigation/DeepLink.swift" \
  "$ROOT/Fortymm/Login/LoginService.swift" \
  "$ROOT/Fortymm/Profile/ProfileService.swift" \
  "$ROOT/Tests/SessionRecoveryTests.swift" -o "$OUTPUT/session-tests"
"$OUTPUT/session-tests"
