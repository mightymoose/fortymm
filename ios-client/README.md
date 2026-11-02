# The iOS app

## Running against the dev stack

The app talks to production, `https://fortymm.com`, unless the launch
environment sets `FORTYMM_API_BASE_URL`. Point it at the web-client dev
server, which proxies `/api/*` to the API and `/oidc/*` to the mock
sign-in provider:

```sh
./bin/mise run up            # from the repo root
./bin/mise run list-ports    # note the web-client-dev port
./bin/mise run ios-client:generate
open ios-client/FortyMM.xcodeproj
```

In Xcode, edit the FortyMM scheme, and under Run, Arguments, add the
environment variable `FORTYMM_API_BASE_URL` with `http://localhost:<port>`.
The simulator shares the Mac's network, so `localhost` reaches the dev
server. Xcode asks once to trust the OpenAPI generator's build plugin.

Sign in opens the mock provider's page. Type any subject, and claims such as
`{"email": "ann@example.com", "email_verified": true}`.

The app keeps its session cookie and its signing key in the Keychain, one
item per base URL, so a dev session never goes to production. Deleting the
app doesn't clear the Keychain on iOS. Sign out to start over, which signs
the key out and deletes it.

To run the UI tests that need the dev API, pass the same URL:

```sh
FORTYMM_API_BASE_URL=http://localhost:<port> ./bin/mise run ios-client:ci
```

Without it, those tests skip. The others run against a stub server inside
the test runner, so they never need the dev stack or reach production.

## The API client

Apple's swift-openapi-generator writes the client at build time from
`api/openapi.json`, which the target lists by path. Its config is
`FortyMM/API/openapi-generator-config.yaml`, which lists the operations the
app calls. To call another operation, add its `operationId` there. A schema
change that breaks the app breaks its build. `FortyMMAPI` turns the generated
responses into the app's own types and `Failure`.

The command line trusts the build plugin with `-skipPackagePluginValidation`,
which `bin/xcodebuild-test` and `bin/xcodebuild-testflight` pass.

## Releasing the iOS app

Each push to `main` that changes the app uploads it to TestFlight (see the
ios-client section of CLAUDE.md). The upload needs an app record in App Store
Connect and an App Store Connect API key, which a person sets up once. Until
then, the workflow warns and skips the upload.

- The app record is the FortyMM app in App Store Connect, with the bundle
  ID `com.fortymm.ios-client`. It holds the builds of an earlier iOS app,
  versions 0.1.0 to 0.3.0, so this app starts at 0.4.0.
- The build number is the workflow's run number (`github.run_number`).
  Apple needs a build number to be unique only within its version.
- The version that testers see is `MARKETING_VERSION` in `project.yml`.
  Change it there for a new release.
- Xcode signs each build with a cloud-managed distribution certificate, so
  no certificate or provisioning profile is stored in the repo or in GitHub.

### One-time setup

You need the Account Holder or an Admin of the Apple Developer Program team.

The bundle ID and the app record already exist.

1. Create the API key. In App Store Connect, under Users and Access,
   Integrations, App Store Connect API, add a Team key with the Admin role.
   Cloud-managed distribution certificates need Admin. Download its
   `AuthKey_<key ID>.p8`, which Apple offers only once. Note the key ID and
   the issuer ID above the list of keys.
2. Find the team ID, under Membership details in the Apple Developer portal.
3. Give them to GitHub Actions, from the repo:

   ```sh
   gh variable set APPLE_TEAM_ID --body <team ID>
   gh variable set APP_STORE_CONNECT_KEY_ID --body <key ID>
   gh variable set APP_STORE_CONNECT_ISSUER_ID --body <issuer ID>
   gh secret set APP_STORE_CONNECT_KEY < AuthKey_<key ID>.p8
   ```

   Then delete the `.p8` from your machine, or keep it in a password
   manager.

The next push to `main` that changes the app uploads a build. It shows in
App Store Connect under TestFlight after Apple processes it.

### Uploading from a Mac

The same task runs locally. The key's path must be absolute, because the
script runs from `ios-client/`.

```sh
BUILD_NUMBER=<a number above the last upload's> \
APPLE_TEAM_ID=<team ID> \
APP_STORE_CONNECT_KEY_ID=<key ID> \
APP_STORE_CONNECT_ISSUER_ID=<issuer ID> \
APP_STORE_CONNECT_KEY_PATH="$HOME/Downloads/AuthKey_<key ID>.p8" \
./bin/mise run ios-client:testflight
```

A local build number can collide with a later run number, so CI's next
upload would fail. Prefer CI.
