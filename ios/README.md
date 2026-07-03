# Fortymm iOS

SwiftUI iOS app. The Xcode project lives in this directory and is managed directly by Xcode (no xcodegen / Tuist / SPM-only setup).

## First-time setup

1. Install Xcode from the Mac App Store, then:
   ```bash
   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
   sudo xcodebuild -license accept
   xcodebuild -runFirstLaunch
   ```

2. Create the Xcode project (one-time, only if `Fortymm.xcodeproj` doesn't already exist):
   - Open Xcode → **File → New → Project… → iOS → App**
   - Product Name: **Fortymm**
   - Organization Identifier: **com.fortymm**
   - Interface: **SwiftUI**, Language: **Swift**, Storage: **None**
   - Uncheck "Include Tests" unless you want them
   - Save location: this `ios/` directory. Uncheck "Create Git repository" (the repo already exists).
   - Commit `Fortymm.xcodeproj/` and the generated `Fortymm/` source folder.

3. Open and run:
   ```bash
   open Fortymm.xcodeproj
   ```
   Pick a simulator (e.g. iPhone 16) and ⌘R.

## Signing

Simulator builds need no signing. For a physical device, in Xcode → Settings → Accounts add your Apple ID, then in the `Fortymm` target → **Signing & Capabilities** pick your team and let Xcode auto-manage signing. A free Apple ID is enough for on-device dev; the paid Apple Developer Program is only needed for TestFlight / App Store.

## Layout

```
ios/
├── Fortymm.xcodeproj/
├── Fortymm/
│   ├── FortymmApp.swift
│   ├── DesignSystem/
│   │   └── DesignSystemView.swift
│   ├── Components/         # FMButton, FMCard, FMBadge, FMAvatar, …
│   ├── Tokens/             # Color, typography, spacing, radius
│   ├── Generated/
│   │   └── Types.swift     # generated, see "Generated OpenAPI types" below
│   └── Assets.xcassets/
├── openapi/                 # generator config + the anyOf-nullable fix-up script
├── Tools/OpenAPIGeneratorCLI/  # pins swift-openapi-generator; not part of the app
└── README.md
```

The launch screen renders `DesignSystemView` (a showcase of the FortyMM-branded shadcn-equivalent components) in dark mode. Reference: [`docs/designs/design-system.html`](../docs/designs/design-system.html).

> Xcode's "New Project" wizard creates an extra `Fortymm/` wrapper directory by default (so the project sits at `ios/Fortymm/Fortymm.xcodeproj`). If you ever regenerate the project, flatten that wrapper away — sources are referenced relative to the directory containing the `.xcodeproj`, so moving both up one level is safe.

## Generated OpenAPI types

`Fortymm/Generated/Types.swift` is generated from the API's `openapi.json` by `swift-openapi-generator` (types only — nothing here talks to the network; `Networking/APIClient.swift` and the hand-written DTOs in e.g. `MatchFlow/MatchAPI.swift` are unchanged). It exists so the app has a compiler-checked reference for the API's actual schemas and so CI can catch drift, same idea as `web-client/src/api/schema.d.ts`.

After changing FastAPI routes or pydantic schemas, regenerate and commit the result:

```bash
mise run regen-ios-api-types
```

That boots the API if needed, fetches `openapi.json`, runs it through `openapi/fix_openapi_nullable.py`, and writes `Fortymm/Generated/Types.swift`. The fix-up script is required, not cosmetic: `swift-openapi-generator` silently drops any `Optional[T]` field shaped the way Pydantic/FastAPI emit it in OpenAPI 3.1 (`anyOf: [T, {type: null}]`) — no build error, just a warning easy to miss. The script rewrites that into the `nullable: true` form the generator does understand. The `verify-ios` job in the `openapi-schema` CI workflow regenerates the same way and fails the build if the committed file is stale.

`ios/Tools/OpenAPIGeneratorCLI` is a standalone `Package.swift` that only pins the generator version for `swift run` — it's never built as part of the Xcode project. The one real app dependency this adds is `OpenAPIRuntime` (a normal SPM package dependency on the `Fortymm` target, imported by the generated file).
