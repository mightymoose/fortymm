import XCTest

/// The splash screen, located by what VoiceOver reads.
@MainActor
struct SplashScreen {
    let app: XCUIApplication

    static func launch() -> SplashScreen {
        let app = XCUIApplication()
        app.launch()
        return SplashScreen(app: app)
    }

    var wordmark: XCUIElement {
        app.staticTexts["FortyMM"]
    }
}
