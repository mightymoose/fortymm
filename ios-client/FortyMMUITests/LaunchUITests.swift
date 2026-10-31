import XCTest

/// The app against a stub API, so these run without a dev stack.
final class LaunchUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testShowsTheWordmarkWhileTheSessionStarts() throws {
        let api = try StubAPI(.hold)
        let splash = SplashScreen(app: FortyMM.launch(apiBaseURL: api.baseURL))

        XCTAssertTrue(splash.wordmark.waitForExistence(timeout: 10))
        XCTAssertTrue(splash.wordmark.isHittable)

        let screenshot = XCTAttachment(screenshot: splash.app.screenshot())
        screenshot.name = "Splash"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    func testSaysWhenItCantReachTheAPI() throws {
        let api = try StubAPI(.status(503))
        let error = ErrorScreen(app: FortyMM.launch(apiBaseURL: api.baseURL))

        XCTAssertTrue(error.title("Can’t reach FortyMM").waitForExistence(timeout: 10))
        error.tryAgain.tap()
        XCTAssertTrue(error.title("Can’t reach FortyMM").waitForExistence(timeout: 10))
    }
}
