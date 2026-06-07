import SwiftUI

@main
struct FortymmApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
        .task {
            await appDelegate.requestNotificationPermission()
        }
    }
}
