import SwiftUI

@main
struct FortymmApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .preferredColorScheme(.dark)
        }
        .task {
            // Load the session first so a Keychain cookie exists before APNs
            // delivers its token — otherwise registerDeviceToken fires against
            // an unauthenticated endpoint and the token is silently lost.
            await session.load()
            await appDelegate.requestNotificationPermission()
        }
    }
}
