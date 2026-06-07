import SwiftUI
import UIKit

@main
struct FortymmApp: App {
    // SwiftUI has no hook for the APNs device-token callbacks, so we bridge in a
    // minimal UIApplicationDelegate that forwards them to PushNotificationManager.
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}

/// Bridges the remote-notification registration callbacks (which only arrive on
/// the app delegate) to `PushNotificationManager`. Registration itself is
/// triggered from `RootView` once the session has loaded.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushNotificationManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        PushNotificationManager.shared.didFailToRegister(error: error)
    }
}
