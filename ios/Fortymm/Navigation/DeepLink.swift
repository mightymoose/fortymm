import Foundation

/// A link the app knows how to open. Universal Links arrive as the real https
/// URLs the API emails (api/app/email.py) — this maps the two it sends to an
/// in-app destination. Anything else parses to `nil` and is ignored, so a stray
/// link can never present a blank flow.
///
/// `Identifiable` so it can drive a `.fullScreenCover(item:)`; the id folds in
/// the token so re-opening a *different* link re-presents the cover.
enum DeepLink: Identifiable, Equatable {
    /// Magic-link sign-in — `/login/verifying?token=…`. Lands on `VerifyLoginView`.
    case login(token: String)
    /// Email confirmation — `/confirm-email?token=…`. Lands on `ConfirmEmailView`.
    case confirmEmail(token: String)

    var id: String {
        switch self {
        case let .login(token): return "login:\(token)"
        case let .confirmEmail(token): return "confirm:\(token)"
        }
    }

    /// Parse an opened URL into a known destination. Matches on path only — the
    /// Associated Domains entitlement already guarantees the host, and the
    /// emailed links carry the token in the `token` query item. A missing or
    /// empty token, or an unrecognised path, yields `nil`.
    init?(url: URL) {
        guard
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let token = components.queryItems?.first(where: { $0.name == "token" })?.value,
            !token.isEmpty
        else { return nil }

        switch components.path {
        case "/login/verifying":
            self = .login(token: token)
        case "/confirm-email":
            self = .confirmEmail(token: token)
        default:
            return nil
        }
    }
}
