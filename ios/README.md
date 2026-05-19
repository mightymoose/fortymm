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
│   └── Assets.xcassets/
└── README.md
```

The launch screen renders `DesignSystemView` (a showcase of the FortyMM-branded shadcn-equivalent components) in dark mode. Reference: [`docs/designs/design-system.html`](../docs/designs/design-system.html).

> Xcode's "New Project" wizard creates an extra `Fortymm/` wrapper directory by default (so the project sits at `ios/Fortymm/Fortymm.xcodeproj`). If you ever regenerate the project, flatten that wrapper away — sources are referenced relative to the directory containing the `.xcodeproj`, so moving both up one level is safe.
