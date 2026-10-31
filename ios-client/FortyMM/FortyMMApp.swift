import SwiftUI

@main
struct FortyMMApp: App {
    @State private var model: AppModel? = AppEnvironment.isTestHost ? nil : Self.makeModel()

    var body: some Scene {
        WindowGroup {
            if let model {
                RootView(model: model)
            } else {
                SplashView()
            }
        }
    }

    @MainActor
    private static func makeModel() -> AppModel {
        let baseURL = AppEnvironment.apiBaseURL
        let jar = CookieJar(store: KeychainCookieStore(account: baseURL.absoluteString))
        return AppModel(api: FortyMMAPI(baseURL: baseURL, jar: jar))
    }
}
