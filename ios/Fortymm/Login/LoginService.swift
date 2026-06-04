import Foundation

/// Gateway to the magic-link sign-in endpoints. Mirrors how `MatchService` /
/// `ProfileService` wrap `APIClient`.
///
/// The flow: `requestLink` emails a single-use, 15-minute token; the user taps
/// the link and `consume` redeems it, minting a fresh session and folding the
/// caller's current guest matches into the signed-in account.
struct LoginService {
    static let shared = LoginService()

    private let client: APIClient
    init(client: APIClient = .shared) { self.client = client }

    /// Request a sign-in link (`POST /v1/login/request`, 202). Captcha-gated like
    /// the web flow. Returns the lowercased address the link was sent to — the
    /// server echoes it identically whether or not an account exists, so the
    /// response leaks nothing about who's registered.
    @discardableResult
    func requestLink(
        email: String,
        captchaToken: String,
        honeypot: String = ""
    ) async throws -> String {
        let response: LoginRequestAccepted = try await client.post(
            "/v1/login/request",
            body: RequestLoginBody(
                email: email, captchaToken: captchaToken, fmmHpToken: honeypot
            )
        )
        return response.email
    }

    /// Redeem a magic-link token (`POST /v1/login/consume`). Returns the full
    /// session — including `merged` when the prior guest's matches were carried
    /// into the account — so the success screen can report what moved.
    ///
    /// Classifies failure for the caller: a `4xx` is a rejected token (expired,
    /// used, wrong account) and terminal; anything else (server error, offline)
    /// is transient and worth a retry. Keeping that distinction here, not in the
    /// view, is the same boundary-typing the rest of the API layer follows.
    func consume(token: String) async throws -> SessionResponse {
        do {
            return try await client.post(
                "/v1/login/consume", body: ConsumeLoginBody(token: token)
            )
        } catch let APIError.http(status, _) where (400..<500).contains(status) {
            throw LoginConsumeError.rejected
        } catch {
            throw LoginConsumeError.unreachable
        }
    }
}

/// Why redeeming a sign-in link failed, classified for the UI.
enum LoginConsumeError: Error {
    /// The link is no longer valid — expired, already used, or for another
    /// account. Terminal; the user must request a fresh link.
    case rejected
    /// The server couldn't be reached (5xx / timeout / offline). Retrying the
    /// same still-valid link may succeed.
    case unreachable
}

/// 202 body for the link-request endpoint — just the echoed address.
struct LoginRequestAccepted: Decodable {
    let email: String
}

// MARK: - Request bodies (snake_case via APIClient's encoder)

private struct RequestLoginBody: Encodable {
    let email: String
    let captchaToken: String
    let fmmHpToken: String
}

private struct ConsumeLoginBody: Encodable {
    let token: String
}
