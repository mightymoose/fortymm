//
//  DashboardScreen.swift
//  FortymmUITests
//
//  Screen object for the Dashboard tab (`Fortymm/Dashboard/DashboardView.swift`)
//  — the XCUITest analog of `e2e/page-objects/dashboard.page.ts`. One Swift
//  type per screen, exposing named element accessors so specs read intent
//  ("the rating card's empty state") rather than raw XCUIElement predicates.
//  See docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md
//  for the screen-object + accessibilityIdentifier convention this follows.
//

import XCTest

/// Wraps the Dashboard's `XCUIElement` queries/actions. Home is the app's
/// default selected tab (`MainTabView`), so no navigation step is needed to
/// reach it — construct this right after `app.launch()`.
struct DashboardScreen {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    /// The empty rating card's copy for a fresh/unrated player: "Unrated —
    /// finish a rated match to start your rating"
    /// (`DashboardView.swift`'s `emptyRatingCard`, `.unrated` case). Tagged
    /// `dashboard.rating.empty` in chore 1b.
    var ratingEmpty: XCUIElement {
        app.staticTexts["dashboard.rating.empty"]
    }

    /// The recent-results card's empty copy: "No completed matches yet."
    /// (`DashboardWidgets.swift`'s `DashboardRecentResultsCard`). Tagged
    /// `dashboard.recentResults.empty` in chore 1b.
    var recentResultsEmpty: XCUIElement {
        app.staticTexts["dashboard.recentResults.empty"]
    }

    /// The loading placeholder shown while the session/dashboard bootstrap is
    /// still in flight (`DashboardView.swift`'s `loadingCard`). It is plain
    /// `Text("Loading your dashboard…")` with no `.accessibilityIdentifier` —
    /// querying `staticTexts` by this string falls back to matching the
    /// element's accessibility label, since SwiftUI `Text` has no identifier
    /// of its own until one is set explicitly.
    var loadingText: XCUIElement {
        app.staticTexts["Loading your dashboard…"]
    }

    /// Waits (up to `timeout` each) for both fresh-guest empty-state elements
    /// to appear. Returns whether both showed up in time — callers still do
    /// their own `XCTAssert` so failures point at *which* element was missing.
    @discardableResult
    func waitForEmptyState(timeout: TimeInterval = 15) -> Bool {
        let ratingAppeared = ratingEmpty.waitForExistence(timeout: timeout)
        let recentResultsAppeared = recentResultsEmpty.waitForExistence(timeout: timeout)
        return ratingAppeared && recentResultsAppeared
    }
}
