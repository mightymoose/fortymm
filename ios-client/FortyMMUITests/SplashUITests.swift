import XCTest

final class SplashUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testShowsTheWordmark() {
        let splash = SplashScreen.launch()

        XCTAssertTrue(splash.wordmark.waitForExistence(timeout: 10))
        XCTAssertTrue(splash.wordmark.isHittable)

        let screenshot = XCTAttachment(screenshot: splash.app.screenshot())
        screenshot.name = "Splash"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
