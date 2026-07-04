import UIKit
import UserNotifications

/// Identifiers shared with the backend push payload (`api/app/notifications`).
/// A push whose `aps.category` is `MATCH_RESULT_CONFIRMATION` renders the
/// Approve / Suggest-correction buttons registered below; the `match_id`
/// userInfo key tells the app which match the buttons (and a tap) act on. Kept
/// in one place so the device-side registration can't drift from what the
/// server sends.
enum MatchNotification {
    /// Must equal `MATCH_RESULT_CONFIRMATION_CATEGORY` in `app/notifications/apns.py`.
    static let category = "MATCH_RESULT_CONFIRMATION"
    /// Surface verb is "Accept" (the confirm verb was replaced by the
    /// propose/accept negotiation); the wire identifier stays stable.
    static let approveAction = "CONFIRM_MATCH_ACTION"
    /// Surface verb is "Suggest correction" (the dispute verb was replaced by
    /// the propose/accept negotiation); the wire identifier stays stable.
    static let suggestCorrectionAction = "DISPUTE_MATCH_ACTION"
    /// Must equal the `data` key the server sends (`{"match_id": "<uuid>"}`).
    static let matchIdKey = "match_id"
}

/// Owns the device side of remote (APNs) push notifications:
///
/// 1. asks the user for permission and registers with APNs,
/// 2. receives the APNs device token (via the app delegate, see
///    `FortymmApp.swift`), hex-encodes it, and POSTs it to the backend so the
///    server can push to this device,
/// 3. registers the "match result" notification category so a result-awaiting
///    push carries Accept / Suggest-correction action buttons,
/// 4. presents pushes as a banner even while the app is foregrounded (otherwise
///    a self-test looks like nothing happened),
/// 5. handles a tapped action: Accept accepts the standing proposal in the
///    background (no need to open the app); Suggest correction and a body tap
///    both deep-link to the match via `onOpenMatch`.
///
/// A singleton because the `UIApplicationDelegate` token callbacks and the
/// SwiftUI view that triggers registration must talk to the same instance, and
/// it carries no per-view state.
final class PushNotificationManager: NSObject {
    static let shared = PushNotificationManager()

    private let client: APIClient
    private let matchService: MatchService

    /// Set by `RootView` once the signed-in shell is up; invoked when the user
    /// taps a match notification's body (not an action button) to route to that
    /// match. A tap that lands before this is wired (cold launch) is buffered in
    /// `pendingMatchOpen` and flushed when the callback is set.
    var onOpenMatch: ((UUID) -> Void)? {
        didSet {
            guard onOpenMatch != nil, let pending = pendingMatchOpen else { return }
            pendingMatchOpen = nil
            onOpenMatch?(pending)
        }
    }

    private var pendingMatchOpen: UUID?

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

    init(client: APIClient = .shared, matchService: MatchService = .shared) {
        self.client = client
        self.matchService = matchService
        super.init()
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([Self.matchConfirmationCategory()])
    }

    /// The "a result is waiting on you" category: Accept accepts the standing
    /// proposal in the background (no `.foreground` — a quick tap acts without
    /// opening the app). Suggesting a correction needs the full board editor,
    /// so that action opens the app on the match instead of acting inline.
    private static func matchConfirmationCategory() -> UNNotificationCategory {
        let approve = UNNotificationAction(
            identifier: MatchNotification.approveAction,
            title: "Accept",
            options: []
        )
        let suggestCorrection = UNNotificationAction(
            identifier: MatchNotification.suggestCorrectionAction,
            title: "Suggest correction",
            options: [.foreground]
        )
        return UNNotificationCategory(
            identifier: MatchNotification.category,
            actions: [approve, suggestCorrection],
            intentIdentifiers: [],
            options: []
        )
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

    /// The user acted on a notification. For a match-result push:
    /// Accept accepts the standing proposal in the background; "Suggest
    /// correction" and a body tap both open the app on the match (a correction
    /// needs the full board editor). Anything we don't recognise — or a payload
    /// missing its `match_id` — just dismisses.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let userInfo = response.notification.request.content.userInfo
        guard
            let raw = userInfo[MatchNotification.matchIdKey] as? String,
            let matchId = UUID(uuidString: raw)
        else {
            completionHandler()
            return
        }

        switch response.actionIdentifier {
        case MatchNotification.approveAction:
            // The push payload carries only the match id; the service fetches
            // the match to resolve the standing proposal (the acceptance
            // token) and accepts it. Best-effort: a failed acceptance (the
            // proposal moved on, or was already accepted) shouldn't hang the
            // notification — the match screen reconciles state on next open.
            // iOS gives this background action a short window; the fetch +
            // accept pair fits comfortably.
            Task {
                do {
                    _ = try await self.matchService.acceptStandingResult(matchId)
                } catch {
                    print("[push] match accept failed: \(error.fmMessage)")
                }
                completionHandler()
            }
        case MatchNotification.suggestCorrectionAction, UNNotificationDefaultActionIdentifier:
            // A correction needs the full board editor — open the app on the
            // match (the action is registered `.foreground`), same as a body
            // tap.
            // Body tap → open the match. Hop to the main actor: `onOpenMatch`
            // drives SwiftUI state.
            DispatchQueue.main.async {
                self.openMatch(matchId)
                completionHandler()
            }
        default:
            completionHandler()
        }
    }

    /// Route a body tap to the match, buffering until `RootView` wires
    /// `onOpenMatch` (a cold-launch tap can arrive before the shell is up).
    private func openMatch(_ matchId: UUID) {
        if let onOpenMatch {
            onOpenMatch(matchId)
        } else {
            pendingMatchOpen = matchId
        }
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
