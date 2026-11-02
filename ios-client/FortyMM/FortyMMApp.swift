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
        // iOS gives an app the model's name, such as "iPhone", rather than
        // the name the person gave the device.
        let keys = DeviceKeys(
            store: KeychainDeviceKeyStore(account: baseURL.absoluteString),
            label: String(UIDevice.current.name.prefix(50))
        )
        return AppModel(api: FortyMMAPI(baseURL: baseURL, jar: jar), keys: keys)
    }
}
