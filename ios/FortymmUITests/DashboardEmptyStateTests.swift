//
//  DashboardEmptyStateTests.swift
//  FortymmUITests
//
//  Tracer-bullet spec (chore 1c): proves the whole XCUITest pipeline — test
//  target, screen object, real-backend wiring, CI — with the narrowest
//  scenario available. A fresh guest launching the app mints a session
//  (`GET /v1/session`, same auto-provision behavior as web) and the Dashboard
//  settles into its empty state without ever getting stuck on the loading
//  placeholder.
//
//  Per the ADR's same-day correction, iOS has no first-match hero like web's
//  — a fresh guest instead sees two independent, already-existing empty
//  states once `GET /v1/dashboard` resolves: the rating card's `.unrated`
//  copy ("Unrated — finish a rated match to start your rating",
//  DashboardView.swift:218) and the recent-results card's empty copy ("No
//  completed matches yet.", DashboardWidgets.swift:254). See
//  docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md.
//
//  Cold launch also surfaces the notification-authorization prompt: `RootView`
//  asks for permission the moment the session resolves, so on a simulator with
//  no recorded decision the system alert can cover the app while
//  `GET /v1/dashboard` is still in flight. An interruption monitor registered
//  before launch (see `setUpWithError`) handles that prompt and only that
//  prompt, choosing **Allow** so the test sees through to the dashboard.
//
//  Requires a running backend. Point it at one via `FMM_API_BASE_URL` in the
//  environment `xcodebuild test` (or the `FortymmUITests` scheme's Test
//  action) runs with — see `setUpWithError` for exactly how that reaches the
//  app process.
//

import XCTest

final class DashboardEmptyStateTests: XCTestCase {
    /// Fallback backend URL when the test runner's own environment carries no
    /// `FMM_API_BASE_URL` override — the docker-compose dev stack's nginx
    /// port (`docker-compose.dev.yml`), the same default a local Xcode run of
    /// the app documents in `ios/CLAUDE.md`.
    private static let defaultAPIBaseURL = "http://localhost:8080"

    /// The app's display name as the system spells it inside permission
    /// prompts — `INFOPLIST_KEY_CFBundleDisplayName` in the Xcode project,
    /// which is "FortyMM", not the target name "Fortymm".
    private static let appDisplayName = "FortyMM"

    /// The stable tail of the system notification-authorization prompt's
    /// title: "“FortyMM” Would Like to Send You Notifications". Matching this
    /// phrase (plus the display name above) is what keeps the interruption
    /// monitor from touching any other alert.
    private static let notificationPromptPhrase = "Would Like to Send You Notifications"

    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false

        app = XCUIApplication()

        // `ProcessInfo.processInfo.environment` here is *this test runner
        // process's* environment — inherited from whatever invoked
        // `xcodebuild test` (a shell's `env FMM_API_BASE_URL=... xcodebuild
        // test ...`, or the `FortymmUITests` scheme's own Test-action
        // environment variables in Xcode). XCUITest launches the app under
        // test as a *separate* process, so that value does not reach it on
        // its own — it must be copied onto `XCUIApplication.launchEnvironment`
        // explicitly, which XCUITest *does* deliver to the launched process's
        // environment. `APIClient.baseURL` (Networking/APIClient.swift) reads
        // the same `FMM_API_BASE_URL` key via `ProcessInfo.processInfo
        // .environment` inside the app, so this is the one hop that gets a
        // CI- or locally-chosen backend URL from the test invocation into the
        // running app. Falls back to the compose dev stack's URL so a bare
        // `xcodebuild test` run (no override set) still targets something
        // real rather than silently hitting the UAT default baked into
        // `APIClient`.
        let apiBaseURL = ProcessInfo.processInfo.environment["FMM_API_BASE_URL"]
            ?? Self.defaultAPIBaseURL
        app.launchEnvironment["FMM_API_BASE_URL"] = apiBaseURL

        // Fresh-guest assumption: this test does not itself clear any
        // Keychain-held session token (`SessionTokenStore`) or reinstall the
        // app — doing so would need app-side hooks, out of scope for this
        // screen-object + spec chore. Two things make "fresh guest" hold
        // anyway:
        //   1. In CI (chore 1e), `FortymmUITests` runs on a freshly
        //      provisioned macOS runner + simulator, so there is no
        //      pre-existing Keychain entry for this app's bundle id to begin
        //      with — every run mints a brand-new guest.
        //   2. Locally, on a simulator that has already run this app, erase
        //      its content first (Simulator > Device > Erase All Content and
        //      Settings) or uninstall the app so a stale guest token from a
        //         previous run isn't reused.
        // Note the assertions below don't actually depend on literal
        // freshness — they hold for *any* guest with zero completed rated
        // matches — but a genuinely fresh guest is what this spec is meant to
        // exercise end to end (guest-session mint included).
        //
        // The notification-authorization prompt is a *system* alert, and
        // XCTest dispatches interruption monitors only while the app under
        // test performs an interaction — the passive `waitForExistence`
        // waits below never provide one, so an unhandled prompt would sit
        // over the app for the whole test. Register the monitor before
        // `launch()` because the prompt can be up within the first seconds
        // of the cold session request; the interaction that triggers it
        // happens in the test body, once the session has resolved (see the
        // tap there).
        addUIInterruptionMonitor(
            withDescription: "\(Self.appDisplayName) notification permission prompt"
        ) { alert in
            Self.handleNotificationPermissionAlert(alert)
        }

        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    /// Handles ONLY the system notification-authorization prompt: the alert
    /// must be titled with the app's display name plus the fixed "Would Like
    /// to Send You Notifications" wording, and its **Allow** button must
    /// exist, before the handler taps Allow and reports the interruption as
    /// handled. Every other alert returns `false` — XCTest leaves it in
    /// place, so an unexpected obstruction stays visible and fails the test
    /// instead of being silently accepted or dismissed. When the permission
    /// decision was already recorded, no prompt exists and the monitor is
    /// simply never invoked.
    private static func handleNotificationPermissionAlert(_ alert: XCUIElement) -> Bool {
        let title = alert.label
        guard
            title.contains(appDisplayName),
            title.contains(notificationPromptPhrase)
        else { return false }

        let allow = alert.buttons["Allow"]
        guard allow.exists else { return false }
        allow.tap()
        return true
    }

    func testFreshGuestSeesDashboardEmptyState() throws {
        let dashboard = DashboardScreen(app: app)

        // 30s: the cold launch performs two sequential real-backend requests
        // (`GET /v1/session`, then `GET /v1/dashboard`), and slow CI runners
        // have measured the first dashboard wait starting 50s+ after launch.
        // The 15s budget below stays for the second element, which by then
        // loads with the same payload.
        XCTAssertTrue(
            dashboard.ratingEmpty.waitForExistence(timeout: 30),
            "Expected the rating card's empty-state copy "
                + "(\"Unrated — finish a rated match to start your rating\") to appear"
        )

        // The session has resolved by now, so the notification prompt — if
        // this simulator had no recorded permission decision — is up. XCTest
        // invokes interruption monitors only while the app performs an
        // interaction, and this tap is that interaction: with the prompt up
        // it never reaches the app; it triggers the monitor, which taps
        // **Allow** and hands control back. With the decision already
        // recorded there is no prompt, and the tap lands on the dashboard's
        // inert mid-card area (plain text, no controls), changing nothing
        // the assertions below check.
        app.tap()

        XCTAssertTrue(
            dashboard.recentResultsEmpty.waitForExistence(timeout: 15),
            "Expected the recent-results card's empty-state copy "
                + "(\"No completed matches yet.\") to appear"
        )

        XCTAssertTrue(dashboard.ratingEmpty.isHittable, "Rating empty state should be visible on screen")
        XCTAssertTrue(
            dashboard.recentResultsEmpty.isHittable,
            "Recent-results empty state should be visible on screen"
        )

        XCTAssertFalse(
            dashboard.loadingText.exists,
            "Dashboard should have settled past \"Loading your dashboard…\" by now"
        )
    }
}
