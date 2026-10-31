import XCTest

/// Sign-in through the dev stack's mock provider. It skips without
/// `FORTYMM_API_BASE_URL`, because iOS CI has no dev stack.
final class SignInUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testSignsInFromTheAccountMenu() throws {
        let app = FortyMM.launch(apiBaseURL: try FortyMM.devAPI())
        let home = HomeScreen(app: app)
        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 15))
        let email = "ann+\(UUID().uuidString.lowercased())@example.com"

        home.openMenu().signIn.tap()
        let sheet = MockSignInSheet(app: app)
        XCTAssertTrue(sheet.subject.waitForExistence(timeout: 15))
        sheet.signIn(email: email)

        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 15))
        let menu = home.openMenu()
        XCTAssertTrue(menu.headline(email).waitForExistence(timeout: 10))
        XCTAssertFalse(menu.signIn.exists)

        menu.signOut.tap()
        XCTAssertTrue(SignedOutScreen(app: app).title.waitForExistence(timeout: 10))
    }

    @MainActor
    func testClosingTheSignInSheetChangesNothing() throws {
        let app = FortyMM.launch(apiBaseURL: try FortyMM.devAPI())
        let signedOut = SignedOutScreen(app: app)
        let home = HomeScreen(app: app)
        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 15))
        let name = home.playerName

        home.openMenu().signIn.tap()
        let sheet = MockSignInSheet(app: app)
        XCTAssertTrue(sheet.subject.waitForExistence(timeout: 15))
        sheet.cancel.tap()

        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 10))
        XCTAssertEqual(home.playerName, name)
        XCTAssertFalse(app.staticTexts["Sign-in didn’t work"].exists)
        XCTAssertFalse(signedOut.title.exists)
    }
}
