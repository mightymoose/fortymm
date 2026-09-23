# FortyMM Android app

This module is the Android entry point for FortyMM. It presents a read-only,
dark Home shell backed by the real guest session. It has no tabs, sign-in
control, fake statistics, or dashboard request yet.

## Session bootstrap

`FortyMMApplication` owns the process-wide `SessionOwner` and OkHttp client.
On launch the owner restores the Android Keystore-backed credential, requests
`GET /v1/session`, captures its root-scoped session and CSRF cookies, and only
reports `Ready` after a new or rotated session credential is durably saved.
The Home shell observes that state and renders loading, the API-returned
username, or a retryable startup error.

## Session recovery

A structured `session_ended` or `session_merged` response from any request
replaces Home with a persistent "Signed out" recovery screen. The owner stores
the reason, not the credential, so a force-stop and relaunch shows the same
screen without a network call. Only "Continue as a new guest" leaves it. That
action runs one cookieless bootstrap under the shared session lock, and its
new credential replaces the stored reason in one atomic write. A response sent
with an earlier credential cannot end or overwrite the recovered guest.

Run the focused JVM session tests and the API 26 device tests with:

```bash
./gradlew :android:testDevDebugUnitTest \
  --tests com.fortymm.android.session.SessionOwnerTest
./gradlew :android:connectedDevDebugAndroidTest
```

For the cold-process demonstration, boot the pinned API 26 emulator and run an
isolated backend, then install the app against the emulator's host gateway:

```bash
QA_PORT=8085 QA_MAILPIT_PORT=8087 scripts/qa-up.sh android-session
./gradlew :android:installDevDebug \
  -PdevApiBaseUrl=http://10.0.2.2:8085

wait_for_username() {
  remote_output="$1"
  local_output="$2"
  for _ in $(seq 1 30); do
    if adb shell uiautomator dump "$remote_output" >/dev/null &&
       adb pull "$remote_output" "$local_output" >/dev/null; then
      ready_nodes="$(xmllint --xpath \
        'count(//node[@package="com.fortymm.android.dev" and string-length(@text) > 0 and not(@text="FortyMM") and not(@text="Home")])' \
        "$local_output" 2>/dev/null || true)"
      if [ "$ready_nodes" = "1" ]; then
        username="$(xmllint --xpath \
          'string(//node[@package="com.fortymm.android.dev" and string-length(@text) > 0 and not(@text="FortyMM") and not(@text="Home")]/@text)' \
          "$local_output")"
        if [ -n "$username" ] && [ "$username" != 'Starting FortyMM…' ]; then
          printf '%s\n' "$username"
          return 0
        fi
      fi
    fi
    sleep 1
  done
  return 1
}

adb shell pm clear com.fortymm.android.dev
adb shell am start -W \
  -n com.fortymm.android.dev/com.fortymm.android.MainActivity
first_username="$(wait_for_username \
  /sdcard/fortymm-first.xml /tmp/fortymm-first.xml)" || exit 1
adb shell am force-stop com.fortymm.android.dev
adb shell am start -W \
  -n com.fortymm.android.dev/com.fortymm.android.MainActivity
relaunch_username="$(wait_for_username \
  /sdcard/fortymm-relaunch.xml /tmp/fortymm-relaunch.xml)" || exit 1
test "$first_username" = "$relaunch_username"
```

The final `test` must confirm the same API-generated username. The focused MockWebServer
tests verify the stable user ID, authenticated restoration request, and exact
bootstrap request counts at the HTTP boundary; do not inspect the backend
database or log raw credentials as proof. Tear the stack down with
`scripts/qa-down.sh android-session`.

## Pinned baseline

| Tool | Version |
| --- | --- |
| JDK | Eclipse Temurin 17.0.17+10 |
| Gradle wrapper | 8.13 |
| Android Gradle Plugin | 8.13.2 |
| Kotlin and Compose compiler plugin | 2.2.21 |
| Compose BOM | 2025.10.01 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 26 |
| Android Build Tools | 35.0.0 |
| launch-test system image | API 26 Google APIs (`x86_64` on Linux, `arm64-v8a` on Apple Silicon) |

AGP 8.13 supports API 36.1 and requires Gradle 8.13 and JDK 17; the initial
versions above stay on that supported baseline.

## Command-line setup and launch check

Android Studio is not required. Install the JDK with `mise install java`, then
install the Android command-line tools and set `ANDROID_HOME` to their SDK root.
Install the pinned packages:

```bash
sdkmanager --install \
  "platform-tools" \
  "platforms;android-36" \
  "build-tools;35.0.0" \
  "emulator" \
  "system-images;android-26;google_apis;arm64-v8a"
```

On Linux CI, use `system-images;android-26;google_apis;x86_64` instead. Create
and boot an API 26 AVD, then run the same public launch check used by CI:

```bash
mise run android-launch-check
```

The command builds the development debug APK and test APK, installs them,
launches `MainActivity`, and checks the public Compose semantics for the FortyMM
Home shell. The GitHub Actions workflow performs the equivalent clean-checkout
run on an API 26 Google APIs emulator.

## Variants and local endpoints

The installable variants are isolated by application ID:

| Variant | Build task | Application ID | Launcher label | Endpoint |
| --- | --- | --- | --- | --- |
| Development | `:android:assembleDevDebug` | `com.fortymm.android.dev` | FortyMM Dev | `http://127.0.0.1:8080` by default |
| QA | `:android:assembleQaDebug` | `com.fortymm.android.qa` | FortyMM QA | `http://127.0.0.1:8080` by default |
| Release | `:android:assembleProductionRelease` | `com.fortymm.android` | FortyMM | `https://uat.fortymm.com` |

Development and QA accept only local cleartext hosts (`localhost`, `127.0.0.1`,
and emulator host `10.0.2.2`). To point either at an isolated local API at build
time, pass its endpoint while building and installing that variant:

```bash
./gradlew :android:installDevDebug -PdevApiBaseUrl=http://10.0.2.2:8080
scripts/qa-up.sh android-qa
# Use the QA port that qa-up.sh prints (the default is 8085 when available).
./gradlew :android:installQaDebug -PqaApiBaseUrl=http://10.0.2.2:<QA_PORT>
```

The release variant has no endpoint property or cleartext exception. Verify the
three packaged application IDs and labels, plus the release manifest's cleartext
policy, with:

```bash
./gradlew :android:verifyVariantArtifacts
```

Run the controlled-server transport probes on an API 26 emulator with:

```bash
./gradlew :android:connectedDevDebugAndroidTest :android:connectedQaDebugAndroidTest :android:connectedProductionDebugAndroidTest
```
