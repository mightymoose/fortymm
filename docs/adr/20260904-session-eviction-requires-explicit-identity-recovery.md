# Session eviction requires explicit identity recovery

Issue [#1641](https://github.com/mightymoose/fortymm/issues/1641) replaces the
passive-reload exception in [ADR 0004](0004-session-invalid-401-carries-a-code.md).
A claimed account silently becoming an empty guest can make a player record
new matches under an identity they cannot recover.

Redeeming a mailed link still revokes that account's other sessions. Detection
happens on the next request, not through a new polling or push mechanism.
`GET /v1/session` returns the existing structured `session_ended` 401 when a
supplied credential is unusable. Only a missing credential without its CSRF
companion can bootstrap a first-visit guest. The companion survives the 401
clearing the rejected session cookie, closing the window where a concurrent or
subsequent request could otherwise mint a guest. Explicit new-guest creation
clears both cookies before bootstrapping.

Once detected, session-ended persists in browser storage and propagates to all
same-origin tabs. The app closes realtime connections, clears account caches,
and routes to sign-in with a visible explanation. Reloading or opening an app
route directly must not create a guest. Successful sign-in or an explicit
“Continue as a new guest” is the recovery choice; sign-in leads to the dashboard.
Explicit sign-out publishes the ended state before clearing browser cookies.
New-guest recovery uses the shared session-bootstrap lock and reuses an identity
already recovered by another tab. Successful identity changes tell other tabs
to discard their old account caches and reload the current session; a later
sign-out takes precedence over a delayed identity-change notification.
The native app persists the noncredential explanation in UserDefaults while
credentials remain in Keychain. Incoming email links remain available while
signed out, so recovery itself is never blocked by session bootstrap.

A browser already signed in to a different claimed account must approve an
account switch before redeeming either a sign-in or confirmation link. The
side-effect-free preview names the current and destination accounts without
creating a guest. Cancel leaves the session and link intact. Redemption checks
the approval's source user against the request's current session; a changed
source returns `account_switch_required` without consuming the link. The client
asks again using the new identity instead of misreporting an expired link.
An existing guest-merge choice still follows account-switch approval when both
apply. Rechecks and retries retain a declined merge; native preview failures stay
retryable rather than authorizing an automatic merge. Same-account and cookieless links need no account-switch prompt.

No new session table or multi-device login policy is introduced. Unsaved-score
recovery is separate work; this change does not replay rejected writes. A
browser that has removed all cookies and local state remains indistinguishable
from a first visitor.

Verification covers the public session/link endpoints, browser routes and
cross-tab recovery, and native HTTP/session handling. The composed-stack
`e2e/tests/session-recovery.spec.ts` runs with `E2E_BASE_URL` and
`E2E_MAILPIT_URL` pointing at an isolated QA stack. Native session checks run
with `bash ios/Tests/run-session-tests.sh`.
