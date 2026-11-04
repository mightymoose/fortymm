# ios-client

`ios-client/` is the iOS app, in SwiftUI. It has the web client's guest
accounts, sign-in and sign-out, with Home's roadmap. It keeps the device's
signing key and can sign a match result. It builds on the macOS
host with Xcode, not in the dev container.

```sh
./bin/mise run ios-client:generate   # write ios-client/FortyMM.xcodeproj
./bin/mise run ios-client:test       # run the unit tests on an iPhone simulator
./bin/mise run ios-client:e2e        # run the UI tests on an iPhone simulator
./bin/mise run ios-client:ci         # run both
BUILD_NUMBER=7 ./bin/mise run ios-client:testflight  # archive and upload to TestFlight
```

- `project.yml` is the project's source. XcodeGen (`tools` on
  `ios-client:generate`, so Linux never installs it) writes
  `FortyMM.xcodeproj` and `FortyMM/Info.plist` from it. Both are
  gitignored, so run `ios-client:generate` before you open the project in
  Xcode, and after you add a file or change `project.yml`.
- The app bundles Bebas Neue from `references/design-system/fonts/` by
  path, so it has no copy to drift. `DesignToken` (`FortyMM/DesignToken.swift`)
  holds the colour tokens the app uses. `FortyMMTests` (Swift Testing) fails
  if a token's hex differs from `colors_and_type.css`, if the launch
  screen's `LaunchBackground` colour differs from the splash background
  (`Color.bgApp`), or if the font isn't in the bundle. It also bundles
  JetBrains Mono, for the time in the 429 message. Space Grotesk isn't in
  the reference's fonts, so other text uses the system font with Dynamic
  Type.
- The app talks to `FORTYMM_API_BASE_URL` from its launch environment, or
  else `https://fortymm.com`, under `/api`. Point it at the web dev
  server's port for local dev (see `ios-client/README.md`). A hosted unit
  test run makes no request, and every UI test passes a base URL, so tests
  never reach production.
- swift-openapi-generator's build plugin generates the API client from
  `api/openapi.json`, which `project.yml` lists by path.
  `FortyMM/API/openapi-generator-config.yaml` picks the operations the app
  calls. So a schema change that the app's code doesn't handle breaks the
  build. `FortyMMAPI.swift` is the one place that reads the generated types.
  It turns each response into `Account`, `SignInOutcome` or `Failure`.
  The scripts pass `-skipPackagePluginValidation` to trust the plugin.
  `Package.resolved` pins every package. `ios-client:generate` copies it
  into the gitignored project, and the scripts build only from it. After
  you change a package, copy the project's new `Package.resolved` back.
- Apple's cookie storage drops the API's `Secure` cookies over
  `http://localhost`. So the app keeps the session and login cookies
  itself, in the Keychain, one item per base URL. `CookieMiddleware` sends
  them, keeps each `Set-Cookie`, and gives each `POST` its JSON
  `Content-Type`.
- `AppModel` holds the app's state: a phase (`starting`, `ready`, `failed`,
  `signedOut`), the sign-in in flight with its last error, and the sign-out
  in flight. Starting shows the splash, as the web's loading screen.
  A failure shows the web's error page text with Try again.
- The device's signing key (see Signing keys in `docs/matches-api.md`) is a Secure Enclave key, or
  a software key on the Simulator, which has no Secure Enclave.
  `KeychainKeyStore` (`FortyMM/SigningKeys/`) keeps it in the Keychain, one
  item per base URL, `AfterFirstUnlockThisDeviceOnly`. For a Secure
  Enclave key, the item holds the enclave's encrypted handle. The unit
  tests run on the Simulator, so they check only the software key.
- After each session starts, `AppModel` registers the key with a proof for
  the account, in a background task, so the screen never waits. A failure
  changes nothing on screen, and the next start tries again. The API
  answers 200 for a key the account has, so the app keeps no record of
  what it registered. A 409, or a 200 for a revoked key, deletes the key,
  and a new one gets one try. Sign-out waits for that task, so a late
  registration can't bring a key back. It sends the key's id as
  `signing_key_id`, then deletes the key. So a new guest account after a
  sign-out gets a new key. The label is `UIDevice.current.name`.
- `FortyMM/SignedResults/` holds the signed result format: a hand-written
  deterministic CBOR codec (`CBOR.swift`), `MatchResult` and its parts,
  and `SignedResult`, the envelope. `SignedResult.sign()` makes one,
  `countersigned(by:side:)` appends the second signature over the
  received payload bytes, and `qrText` and `link` carry it. `init(bytes:)`
  and `init(text:)` read one strictly, and throw `Malformed`. The app
  checks no signature (the README's V8 and I1), because only the server
  holds the keys. `RegistrationProof` makes the key registration proof.
  Nothing queues signed results yet, so a sign-out has no queue to keep.
- `FortyMMTests` runs the README's client checks K1-K3, V1-V7, R1-R2 and
  I2 on every vector of `api/signed-results/vectors.json`, which
  `project.yml` puts in the test bundle by path. Each vector reports by
  name. CryptoKit signs with a random nonce, so V4 and R2 compare by
  verifying.
- Sign-in uses `POST /v1/auth/app-login` and `app-finish` (see Sign-in in `docs/accounts.md`),
  through SwiftUI's `webAuthenticationSession` with the `fortymm` scheme
  and an ephemeral browser session. That session keeps no provider cookie,
  so sign-out calls `POST /v1/auth/logout` and doesn't open `logout_url`.
  Closing the sheet shows nothing. A refused sign-in shows the web's
  `signInErrors` message in a banner above Home or on the signed-out
  screen.
- Home has the wordmark as the navigation bar's centred title, where iOS
  puts it (a leading toolbar item crops it to a glass capsule), and the
  account menu at the right, whose label is the player's avatar. Its menu matches
  the web's `UserMenu`. A guest's Sign out asks first, in an alert with the
  web dialog's text, "device" for "browser". Signed out shows the web's
  `/signed-out` text with Sign in and Play as a guest. A relaunch after a
  sign-out starts a new guest account, as opening `/` does. There's no tab
  bar while Home is the only page.
- `FortyMMUITests` (XCUITest) launches the app and goes through page objects
  in `Screens.swift`, which find elements by what VoiceOver reads. The
  launch tests answer the app from `StubAPI`, a listener on 127.0.0.1 in the
  test runner. The account and sign-in tests run against the dev stack
  when `FORTYMM_API_BASE_URL` is set, and skip otherwise, so iOS CI skips
  them. `bin/xcodebuild-test` passes it to the runner as
  `TEST_RUNNER_FORTYMM_API_BASE_URL`. The sign-in test fills the mock
  provider's form in the sign-in sheet.
- `bin/xcodebuild-test` runs the tests on the first available iPhone
  simulator, or on `IOS_SIMULATOR` (a name or UDID). It writes a result
  bundle per run to `build/results/`.
- `.github/workflows/ios-client.yml` runs `ios-client:ci` on a macOS runner,
  only on a push that changes the app, its design-system inputs,
  `api/openapi.json`, `api/signed-results/vectors.json`, `mise.toml`,
  `bin/mise` or the workflow. It uploads the result bundles as `ios-client-results`.
- `bin/app-icon` writes the app icon, `AppIcon.png` in
  `FortyMM/Assets.xcassets`, from `references/design-system/assets/logo-mark.svg`
  on `--ink-950`. The PNG has no alpha channel, because the App Store
  refuses one that has. The PNG is committed, so run the script again if
  the logo mark changes.
- On a push to `main`, after the tests, the workflow uploads the app to
  TestFlight with `ios-client:testflight`. `bin/xcodebuild-testflight`
  archives the app unsigned, then exports it with Xcode's cloud-managed
  signing, through an App Store Connect API key, and uploads it. No
  certificate or profile is stored anywhere. The build number is the
  workflow's run number, and the version is `MARKETING_VERSION` in
  `project.yml`. Until the Apple team and the key are set, the workflow
  warns and skips the upload. A run on `main` isn't cancelled by the next
  push, so an upload never stops midway. `ARCHIVE_ONLY=1` stops the script
  after the archive, with no request to Apple. `ios-client/README.md`
  describes the one-time setup.
- `ITSAppUsesNonExemptEncryption` is false in the Info.plist, so TestFlight
  asks no export compliance question per build. An app that adds its own
  encryption must change it.

