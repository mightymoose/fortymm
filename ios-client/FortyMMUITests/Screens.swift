import XCTest

/// Launches the app against an API, and finds its screens by what VoiceOver
/// reads.
@MainActor
enum FortyMM {
    static func launch(apiBaseURL: URL) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["FORTYMM_API_BASE_URL"] = apiBaseURL.absoluteString
        app.launch()
        return app
    }

    /// The dev stack's web dev server, which `bin/xcodebuild-test` passes to
    /// the test runner from `FORTYMM_API_BASE_URL`.
    static func devAPI() throws -> URL {
        guard let value = ProcessInfo.processInfo.environment["FORTYMM_API_BASE_URL"], !value.isEmpty,
              let url = URL(string: value)
        else { throw XCTSkip("Set FORTYMM_API_BASE_URL to the dev stack's web dev server to run this test.") }
        return url
    }
}

@MainActor
struct SplashScreen {
    let app: XCUIApplication

    var wordmark: XCUIElement { app.staticTexts["FortyMM"] }
}

@MainActor
struct ErrorScreen {
    let app: XCUIApplication

    func title(_ text: String) -> XCUIElement { app.staticTexts[text] }
    var tryAgain: XCUIElement { app.buttons["Try again"] }
}

@MainActor
struct HomeScreen {
    let app: XCUIApplication

    var title: XCUIElement { app.staticTexts["What’s coming, and when."] }
    var accountMenu: XCUIElement { app.buttons["Your account"] }

    /// The display name of the player the account menu shows.
    var playerName: String { accountMenu.value as? String ?? "" }

    func openMenu() -> AccountMenu {
        accountMenu.tap()
        return AccountMenu(app: app)
    }
}

@MainActor
struct AccountMenu {
    let app: XCUIApplication

    func headline(_ text: String) -> XCUIElement { app.staticTexts[text] }
    /// The player's name, which iOS lists as a dimmed item.
    func player(_ name: String) -> XCUIElement { app.buttons[name] }
    var signIn: XCUIElement { app.buttons["Sign in"] }
    var signOut: XCUIElement { app.buttons["Sign out"] }

    /// Closes the menu with a tap outside it, as a person would.
    func close() {
        let outside = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        for _ in 0..<3 where signOut.exists {
            outside.tap()
            _ = signOut.waitForNonExistence(timeout: 2)
        }
    }
}

@MainActor
struct GuestSignOutDialog {
    let app: XCUIApplication

    var title: XCUIElement { app.staticTexts["Sign out of this guest account?"] }
    var signOut: XCUIElement { app.buttons["Sign out"] }
}

@MainActor
struct SignedOutScreen {
    let app: XCUIApplication

    var title: XCUIElement { app.staticTexts["You’re signed out"] }
    var signIn: XCUIElement { app.buttons["Sign in"] }
    var playAsGuest: XCUIElement { app.buttons["Play as a guest"] }
}

/// The dev stack's mock provider page, in the system's sign-in sheet.
@MainActor
struct MockSignInSheet {
    let app: XCUIApplication

    var subject: XCUIElement { app.webViews.textFields.firstMatch }
    var claims: XCUIElement { app.webViews.textViews.firstMatch }
    var cancel: XCUIElement { app.buttons["Cancel"] }

    /// Signs in as `email`, verified. Return in the subject field submits
    /// the form, so the test needn't reach the button under the toolbar.
    func signIn(email: String) {
        claims.tap()
        claims.typeText(#"{"email": "\#(email)", "email_verified": true}"#)
        subject.tap()
        subject.typeText("\(UUID().uuidString)\n")
    }
}
