# Releasing the iOS app

Each push to `main` that changes the app uploads it to TestFlight (see the
ios-client section of CLAUDE.md). The upload needs an app record in App Store
Connect and an App Store Connect API key, which a person sets up once. Until
then, the workflow warns and skips the upload.

- The build number is the workflow's run number (`github.run_number`), so
  each upload gets a new one.
- The version that testers see is `MARKETING_VERSION` in `project.yml`.
  Change it there for a new release.
- Xcode signs each build with a cloud-managed distribution certificate, so
  no certificate or provisioning profile is stored in the repo or in GitHub.

## One-time setup

You need the Account Holder or an Admin of the Apple Developer Program team.

1. Register the bundle ID. In the Apple Developer portal, under
   Certificates, Identifiers & Profiles, add an App ID with the bundle ID
   `com.fortymm.FortyMM`. Skip this if it's already there.
2. Create the app. In App Store Connect, under Apps, add a new iOS app named
   FortyMM with the bundle ID `com.fortymm.FortyMM`.
3. Create the API key. In App Store Connect, under Users and Access,
   Integrations, App Store Connect API, add a Team key with the Admin role.
   Cloud-managed distribution certificates need Admin. Download its
   `AuthKey_<key ID>.p8`, which Apple offers only once. Note the key ID and
   the issuer ID above the list of keys.
4. Find the team ID, under Membership details in the Apple Developer portal.
5. Give them to GitHub Actions, from the repo:

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

## Uploading from a Mac

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
