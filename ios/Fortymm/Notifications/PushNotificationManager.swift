import UIKit
import UserNotifications

/// Owns the device side of remote (APNs) push notifications:
///
/// 1. asks the user for permission and registers with APNs,
/// 2. receives the APNs device token (via the app delegate, see
///    `FortymmApp.swift`), hex-encodes it, and POSTs it to the backend so the
///    server can push to this device,
/// 3. presents pushes as a banner even while the app is foregrounded (otherwise
///    a self-test looks like nothing happened).
///
/// A singleton because the `UIApplicationDelegate` token callbacks and the
/// SwiftUI view that triggers registration must talk to the same instance, and
/// it carries no per-view state.
final class PushNotificationManager: NSObject {
    static let shared = PushNotificationManager()

    private let client: APIClient

    /// Whether the device-token POST should report a sandbox or production APNs
    /// token. Debug builds register against the APNs sandbox; release builds
    /// (TestFlight / App Store) against production — kept in lockstep with the
    /// `aps-environment` entitlement.
    private static var environment: String {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }

    init(client: APIClient = .shared) {
        self.client = client
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// Ask for notification permission (no-op prompt after the first time — iOS
    /// returns the existing decision) and, if not denied, register with APNs.
    /// Safe to call on every launch; Apple recommends re-registering each launch
    /// so a rotated device token reaches the server.
    func requestAuthorizationAndRegister() {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .badge, .sound]) { granted, error in
            if let error {
                print("[push] authorization error: \(error.localizedDescription)")
            }
            guard granted else {
                print("[push] notifications not granted")
                return
            }
            // registerForRemoteNotifications must run on the main thread.
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Called by the app delegate when APNs hands us a device token. Hex-encode
    /// it (the wire format APNs expects) and send it to the backend.
    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await register(token: hex) }
    }

    func didFailToRegister(error: Error) {
        print("[push] remote registration failed: \(error.localizedDescription)")
    }

    private func register(token: String) async {
        let body = RegisterDeviceTokenRequest(
            token: token,
            platform: "ios",
            environment: Self.environment
        )
        do {
            let _: DeviceTokenRegistration = try await client.post(
                "/v1/device-tokens",
                body: body
            )
        } catch {
            // Best-effort: a failed registration just means this device won't
            // receive pushes until the next successful launch. Don't surface it.
            print("[push] device-token registration failed: \(error.fmMessage)")
        }
    }
}

extension PushNotificationManager: UNUserNotificationCenterDelegate {
    /// Show the banner (and play the sound) even when the app is in the
    /// foreground, so a push that arrives while the user is in the app is
    /// actually visible.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler:
            @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }
}

/// Request body for `POST /v1/device-tokens`. Keys are sent snake_case by
/// `APIClient`'s encoder; these are all single words so they map 1:1.
private struct RegisterDeviceTokenRequest: Encodable {
    let token: String
    let platform: String
    let environment: String
}

/// `POST /v1/device-tokens` response — `{ "registered": true }`.
private struct DeviceTokenRegistration: Decodable {
    let registered: Bool
}
