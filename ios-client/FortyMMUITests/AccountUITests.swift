import XCTest

/// The account flows against the real dev API. They skip without
/// `FORTYMM_API_BASE_URL`, because iOS CI has no dev stack.
final class AccountUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// Launches the app and makes sure it plays as a guest, since the
    /// Keychain keeps the last test's session.
    @MainActor
    private func launchAsGuest() throws -> HomeScreen {
        let app = FortyMM.launch(apiBaseURL: try FortyMM.devAPI())
        let home = HomeScreen(app: app)
        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 15))
        let menu = home.openMenu()
        if menu.headline("Playing as a guest").waitForExistence(timeout: 2) {
            menu.close()
            return home
        }
        menu.signOut.tap()
        let signedOut = SignedOutScreen(app: app)
        XCTAssertTrue(signedOut.title.waitForExistence(timeout: 10))
        signedOut.playAsGuest.tap()
        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 10))
        return home
    }

    @MainActor
    func testLaunchShowsHomeWithAGuestPlayer() throws {
        let home = try launchAsGuest()

        XCTAssertTrue(home.title.waitForExistence(timeout: 5))
        let name = home.playerName
        XCTAssertFalse(name.isEmpty)
        let menu = home.openMenu()
        XCTAssertTrue(menu.headline("Playing as a guest").waitForExistence(timeout: 5))
        XCTAssertTrue(menu.player(name).exists)
        XCTAssertTrue(menu.signIn.exists)
        XCTAssertTrue(menu.signOut.exists)
    }

    @MainActor
    func testRelaunchKeepsThePlayer() throws {
        let home = try launchAsGuest()
        let name = home.playerName

        home.app.terminate()
        home.app.launch()

        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 15))
        XCTAssertEqual(home.playerName, name)
    }

    @MainActor
    func testGuestSignsOutThroughTheConfirmation() throws {
        let home = try launchAsGuest()

        home.openMenu().signOut.tap()
        let dialog = GuestSignOutDialog(app: home.app)
        XCTAssertTrue(dialog.title.waitForExistence(timeout: 5))
        dialog.signOut.tap()

        XCTAssertTrue(SignedOutScreen(app: home.app).title.waitForExistence(timeout: 10))
    }

    @MainActor
    func testPlayAsAGuestGivesANewPlayer() throws {
        let home = try launchAsGuest()
        let name = home.playerName
        home.openMenu().signOut.tap()
        GuestSignOutDialog(app: home.app).signOut.tap()
        let signedOut = SignedOutScreen(app: home.app)
        XCTAssertTrue(signedOut.playAsGuest.waitForExistence(timeout: 10))

        signedOut.playAsGuest.tap()

        XCTAssertTrue(home.accountMenu.waitForExistence(timeout: 10))
        XCTAssertNotEqual(home.playerName, name)
        XCTAssertFalse(home.playerName.isEmpty)
    }
}
