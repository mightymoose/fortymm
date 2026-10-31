import Foundation

enum AppEnvironment {
    /// The origin that serves `/api/*`: production, or the web dev server
    /// that `FORTYMM_API_BASE_URL` names.
    static var apiBaseURL: URL {
        ProcessInfo.processInfo.environment["FORTYMM_API_BASE_URL"].flatMap(URL.init(string:))
            ?? URL(string: "https://fortymm.com")!
    }

    /// The unit tests run inside the app. It must not start a session
    /// there, or every test run would make a guest account in production.
    static var isTestHost: Bool {
        ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }
}
