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
        //      previous run isn't reused.
        // Note the assertions below don't actually depend on literal
        // freshness — they hold for *any* guest with zero completed rated
        // matches — but a genuinely fresh guest is what this spec is meant to
        // exercise end to end (guest-session mint included).
        app.launch()
    }

    override func tearDownWithError() throws {
        app = nil
    }

    func testFreshGuestSeesDashboardEmptyState() throws {
        let dashboard = DashboardScreen(app: app)

        XCTAssertTrue(
            dashboard.ratingEmpty.waitForExistence(timeout: 15),
            "Expected the rating card's empty-state copy "
                + "(\"Unrated — finish a rated match to start your rating\") to appear"
        )
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
