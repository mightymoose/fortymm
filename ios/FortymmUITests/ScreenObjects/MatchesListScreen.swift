//
//  MatchesListScreen.swift
//  FortymmUITests
//
//  Screen object for the Matches tab (`Fortymm/Matches/MatchesListView.swift`).
//  See docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md
//  for the screen-object + accessibilityIdentifier convention this follows.
//

import XCTest

/// Wraps the Matches tab's `XCUIElement` queries/actions.
struct MatchesListScreen {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    /// The "Matches" tab bar item — see `ProfileScreen.tabButton` for why
    /// this is a text-query fallback.
    var tabButton: XCUIElement {
        app.tabBars.buttons["Matches"]
    }

    /// Navigate to this tab. Waits for the tab bar first — see
    /// `ProfileScreen.open` for why a cold launch may not have one yet.
    @discardableResult
    func open(timeout: TimeInterval = 15) -> Self {
        XCTAssertTrue(
            tabButton.waitForExistence(timeout: timeout),
            "The \"Matches\" tab never appeared — the app is probably still bootstrapping its session"
        )
        tabButton.tap()
        return self
    }

    /// A specific match's row, keyed by the match's own server id rather than
    /// its on-screen text (`MatchesListView.swift`'s `MatchRow`, tagged
    /// `matches.row.<uuid>`) — lets a spec that just created a match over the
    /// API (and holds its id) find the exact row without depending on
    /// whatever opponent names/labels happen to render.
    func row(matchId: UUID) -> XCUIElement {
        app.buttons["matches.row.\(matchId.uuidString)"]
    }
}
