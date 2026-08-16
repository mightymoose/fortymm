//
//  ProfileScreen.swift
//  FortymmUITests
//
//  Screen object for the "You" tab (`Fortymm/Profile/ProfileView.swift`).
//  See docs/adr/20260802-ios-e2e-tests-live-in-a-new-xcuitest-ui-test-target.md
//  for the screen-object + accessibilityIdentifier convention this follows.
//

import XCTest

/// Wraps the Profile tab's `XCUIElement` queries/actions.
struct ProfileScreen {
    private let app: XCUIApplication

    init(app: XCUIApplication) {
        self.app = app
    }

    /// The "You" tab bar item — tab labels have no dedicated identifier
    /// (the SwiftUI `Label` text doubles as the accessibility label), so this
    /// is a documented text-query fallback per the screen-object convention.
    var tabButton: XCUIElement {
        app.tabBars.buttons["You"]
    }

    /// The identity header's "@username" text (`ProfileView.swift`'s
    /// `identity(_:)`, tagged `profile.identity.username`) — distinct from
    /// the "Username" settings row below it, which renders the same
    /// "@username" text and would otherwise ambiguously match a label query.
    private var usernameLabel: XCUIElement {
        app.staticTexts["profile.identity.username"]
    }

    /// Navigate to this tab.
    @discardableResult
    func open() -> Self {
        tabButton.tap()
        return self
    }

    /// The signed-in guest's bare username (no leading "@" — the API's player
    /// search takes the raw username, not the display form ProfileView
    /// renders it in). `nil` if the identity header never appeared in time.
    func username(timeout: TimeInterval = 15) -> String? {
        guard usernameLabel.waitForExistence(timeout: timeout) else { return nil }
        let label = usernameLabel.label
        return label.hasPrefix("@") ? String(label.dropFirst()) : label
    }
}
