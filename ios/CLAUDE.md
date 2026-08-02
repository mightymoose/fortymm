# CLAUDE.md — ios/

Guidance for Claude Code when working in `ios/` (the native Swift/SwiftUI iOS app).
This file is the source of truth for iOS conventions; the root `CLAUDE.md` cross-cutting
invariants still apply.

## Repo layout

Native SwiftUI app. The `Fortymm.xcodeproj` is managed directly by Xcode — no
xcodegen / Tuist / SPM-only setup. Two targets: the app (`Fortymm`) and a
`FortymmUITests` XCUITest UI-testing target (see Gotchas).

Sources live in `Fortymm/`, one folder per page-level feature (`Dashboard/`,
`Matches/`, `Login/`, `Profile/`, `MatchFlow/`), each holding its views, its
`*Store` and/or `*Service`, and its models — plus shared `Navigation/`,
`Session/`, `Networking/`, `Components/` (ViewModel-free UI primitives),
`Tokens/` (design tokens), and `Notifications/`. Browse the tree for specifics.

Three things the tree won't tell you:

- `Fortymm/Generated/Types.swift` is **generated** — see `## Cross-layer regen`.
  `openapi/` holds the generator config + `fix_openapi_nullable.py`.
- `Tools/OpenAPIGeneratorCLI/` is a standalone `Package.swift` that only pins
  `swift-openapi-generator` for `swift run`. It is **never built as part of the
  app**.
- `fastlane/` secrets live in the gitignored `fastlane/.env` + `.p8`.

## Common commands

Run from `ios/` unless noted.

```bash
# Quick compile check, no signing (the fast sanity gate — use this after every edit):
xcodebuild build -project Fortymm.xcodeproj -scheme Fortymm \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO
# Same thing via fastlane:
mise exec -- bundle exec fastlane build

# Run on a simulator (from Xcode: open Fortymm.xcodeproj, pick a sim, ⌘R).
# Point a local run at a dev stack by setting FMM_API_BASE_URL in the scheme's
# environment (e.g. http://localhost:8080); default is https://uat.fortymm.com.

# TestFlight release (signed archive + upload; reads fastlane/.env for ASC creds):
mise ios-testflight            # == fastlane beta; bumps build number off TestFlight

# Regenerate the OpenAPI reference types after any API route/schema change:
mise run regen-ios-api-types   # boots API if needed, fetches openapi.json, fixes it, writes Generated/Types.swift
```

**Why `regen-ios-api-types` runs through `openapi/fix_openapi_nullable.py`:**
`swift-openapi-generator` **silently drops** any `Optional[T]` field shaped the way
Pydantic/FastAPI emit it in OpenAPI 3.1 — `anyOf: [T, {type: null}]` — with only a
warning, no build error (e.g. `PlayerRead.rating` just vanishes from the generated
Swift). The script rewrites that into the older `nullable: true` sibling form the
generator actually understands, before generation. The `verify-ios` job in the
`openapi-schema` CI workflow regenerates the same way and fails on drift, so commit
`Generated/Types.swift` in the same PR as the route/schema change.

## Code organization

This app follows a **feature-folder + observable-store** structure (matches the
codebase; align with it, don't reinvent):

- **Feature folders.** One folder per page-level surface (`Dashboard/`, `Matches/`,
  `MatchFlow/`, `Login/`, `Profile/`, `Session/`), each colocating its views, its
  store/service, and its models. Cross-feature reusable UI lives in `Components/`;
  design tokens in `Tokens/`.
- **Observable stores own screen state.** A feature's data is owned by a `@MainActor
  final class …Store: ObservableObject` that imports only `Foundation`/`Combine` (never
  `SwiftUI`). The house pattern is a nested `enum State { case idle, loading,
  loaded(…), failed(String) }` exposed as `@Published private(set) var state`, plus a
  `load(force: Bool = false)` method that skips the network when already loaded and, on
  `force`, refetches **in place** (keeps current content on screen, swaps on arrival, and
  does not blank good content on a transient background-refresh failure). See
  `DashboardStore` — the full exemplar. (`SessionStore` shares the class shape but
  deliberately blanks to `.loading`/`.failed` on refresh and adds a `signedOut` case —
  it's the app-level session gate, not the pattern to copy for a screen.)
- **Services map the wire to view models.** A `…Service` (e.g. `MatchService`) wraps
  `APIClient`, calls endpoints, and maps DTOs → view models. Keep decode-shaped `…DTO`
  types (`MatchAPI.swift`) separate from the UI-facing view models (`MatchModels.swift`).
- **Dependency injection is lightweight.** Inject collaborators through init defaults
  (`init(client: APIClient = .shared)`) — no DI framework. Share process-wide state down
  the view tree via `.environmentObject` (`RootView` creates the `SessionStore` with
  `@StateObject` and injects it; screens read it with `@EnvironmentObject` rather than
  refetching). `APIClient.shared` and `SessionTokenStore.shared` are the app-wide
  singletons.
- **Networking is centralized.** All HTTP goes through `Networking/APIClient` — do not
  hand-roll `URLSession` calls in a view or store.
- **Pure/dumb views need no store.** `Components/` primitives just render inputs; reserve
  stores for page roots.

## Boundaries

Per the root rule (`.claude/rules/parse-at-boundaries.md`): **parse untrusted data at
the boundary, carry typed values inward.** On iOS the parser is **`Codable`**.

- Network responses decode through `APIClient`'s shared `JSONDecoder`, configured with
  `.convertFromSnakeCase` (so `status_label` → `statusLabel`) and a custom ISO-8601 date
  strategy (fractional-seconds formatter first, plain fallback).
- Model DTOs after the API's actual schemas; `Generated/Types.swift` is the
  compiler-checked reference for those shapes. The hand-written DTOs (e.g. in
  `MatchFlow/MatchAPI.swift`) are **not** migrated onto the generated types yet — the
  generated file exists for reference + CI drift-guard only.
- **Request bodies with digit-segment keys** (`side_1_points`) can't be produced by
  `.convertToSnakeCase` from a camelCase name — give those `Encodable`s explicit
  snake-case `CodingKeys` (which pass through unchanged). See `PostResultsBody.GameWrite`,
  `GameScoreWriteBody`.
- **Decode leniently and narrowly.** String enums adopt `LenientRawDecodable` so an
  unrecognised server value decodes to `.unknown` instead of throwing. Leave wire fields
  the app doesn't read **undeclared** (JSONDecoder ignores them) so decoding never breaks
  when the server adds/removes a field it doesn't use.
- Surface the API's own error message: non-2xx bodies (`{"detail": …}`, string or 422
  validation array) are humanized in `APIClient` and thrown as `APIError`; read them at
  call sites via `error.fmMessage`.

## Gotchas (hard-won — read before you touch these areas)

- **There IS now a `FortymmUITests` XCUITest UI-testing target** (added to automate the
  Dashboard empty-state flow end to end — see
  `docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md`). It's wired
  via a `PBXFileSystemSynchronizedRootGroup` at `ios/FortymmUITests/`, so new `.swift`
  files dropped there auto-attach to that target — same Xcode-16 sync-group mechanism as
  the app target, just scoped to a different target: dropping a file in `Fortymm/` still
  only ever reaches the app target, dropping one in `FortymmUITests/` only ever reaches
  the test target. Run it with:
  ```bash
  xcodebuild test -project Fortymm.xcodeproj -scheme Fortymm \
    -destination 'platform=iOS Simulator,name=iPhone 17' -only-testing:FortymmUITests
  ```
  (omit `-only-testing` to run everything; or from Xcode, select the
  `FortymmUITests`-inclusive `Fortymm` scheme and Product > Test). To point a run at a
  backend, set `FMM_API_BASE_URL` — same mechanism as a normal run
  (`Fortymm/Networking/APIClient.swift:24`), but for UI tests it must be explicitly
  forwarded from the test process's own environment onto
  `XCUIApplication().launchEnvironment[...]` before `.launch()`, since XCUITest launches
  the app as a separate process and the test's own env isn't automatically visible to it
  — see `FortymmUITests/DashboardEmptyStateTests.swift`'s `setUpWithError` for the
  pattern. Locally/in cloud sessions, point it at `docker-compose.dev.yml` as usual; CI
  (`ios.yml`, `macos-latest`) instead boots the backend as native processes (Postgres via
  Homebrew + `uvicorn`, no Docker) because GitHub-hosted macOS runners can't run Docker
  containers — see
  `docs/adr/20260802-ios-e2e-ci-runs-the-backend-as-native-processes-not-docker.md`; don't
  try to add `docker compose` to `ios.yml`.

  **Screen-object + accessibilityIdentifier convention:** one Swift type per screen
  wrapping `XCUIElement` queries/actions (e.g. `FortymmUITests/ScreenObjects/DashboardScreen.swift`),
  mirroring the Playwright `page-objects/` pattern in root `e2e/`. Query elements by an
  explicit `.accessibilityIdentifier(...)` added to the view, not by visible text/label,
  wherever practical — text/label matching (e.g. matching a `Text`'s literal string) is a
  documented fallback only for elements that don't yet have an identifier. Add identifiers
  to a screen's views incrementally, as that screen gains XCUITest coverage — don't
  blanket-tag a whole screen up front.

  This is still not a general-purpose unit-test target — for pure-Swift, non-UI logic, a
  standalone `swiftc` harness in a temp dir remains the fastest check and needs no
  simulator: `swiftc rules.swift main.swift` (copy the source files you need, add a
  `main.swift` that exercises them), run it, delete it. Keep UI/XCUITest specs in
  `FortymmUITests/` instead — a file dropped into `Fortymm/` auto-attaches to the app
  target via the same Xcode 16 sync groups, which can't link XCTest and breaks the app
  build.

- **Xcode 16 synchronized file groups: new `.swift` files under `Fortymm/` are
  auto-included — no `project.pbxproj` edit needed.** Just create the file. **Non-source**
  files (e.g. `*.entitlements`) still need a build-setting edit. `project.pbxproj` is
  **TAB-indented and the Edit tool mangles tabs** — patch it via a small Python
  `str.replace` using `\t` literals, not the Edit tool.

- **Incremental builds silently serve a STALE dylib.** `xcodebuild … build` can print
  **BUILD SUCCEEDED** while `Fortymm.app/Fortymm.debug.dylib` keeps its old mtime and
  contents — Debug code lives in the `.debug.dylib` and the executable is a thin launcher.
  After an edit, verify the dylib's mtime / `strings` actually changed; if stale,
  `rm -rf build/sim` and do a full clean rebuild. Always **uninstall + install the fresh
  `.app`** on the simulator rather than trusting an in-place update.

- **`.convertFromSnakeCase` mangles the KEYS inside a `[String: T]` dictionary property**
  (`in_progress` → `inProgress`) — **only on iOS 17's objc-Foundation**, NOT on
  iOS 18+/macOS swift-foundation. The deployment target is **17.0**, so the bug is live in
  production. A macOS `swiftc` decode probe runs swift-foundation and **cannot reproduce
  it** — do not "confirm" the behavior from a macOS probe. Model such maps as a typed
  value that re-canonicalizes keys back to snake_case at the boundary (see `StatusCounts`
  handling around `MatchListResponseDTO.statusCounts` in `MatchFlow/`).

- **SwiftUI `TextField` won't live-rewrite a FOCUSED field** from a binding-setter
  normalization (e.g. `"011"` → `"11"` only shows once the field loses focus).
  `DispatchQueue.main.async` doesn't help. For live repaint you need a
  `UIViewRepresentable`-wrapped `UITextField`; otherwise normalize the binding and accept
  the transient display until focus-out.

- **Session loads once, at startup.** `RootView` loads the session into
  `SessionStore` (a shared object injected via the environment) once at launch;
  screens read it via `@EnvironmentObject` rather than re-fetching
  `GET /v1/session` themselves. Keep new surfaces that need the current user on
  this pattern — read from `SessionStore`, don't add another per-screen fetch.

## Cross-layer regen

When you change API-touching code, the API's OpenAPI schema may have moved and
`Generated/Types.swift` may need regeneration (`mise run regen-ios-api-types`). This
requires a running API and touches other layers — **flag any needed regen to the main
session** rather than assuming the iOS worktree can regenerate on its own.
