import Foundation

/// The profile/settings gateway to the API. Wraps `APIClient` with the
/// account-management endpoints — username (`PATCH /v1/me`) and the
/// Turnstile-gated email change + resend (`POST /v1/me/email[/resend]`). Each
/// returns the refreshed `SessionUser` so the caller can fold it straight into
/// `SessionStore` without a second `GET /v1/session`.
struct ProfileService {
    static let shared = ProfileService()

    private let client: APIClient
    init(client: APIClient = .shared) { self.client = client }

    /// Change the username (`PATCH /v1/me`). The server enforces the same
    /// pattern the client checks, plus uniqueness: a duplicate comes back 409
    /// and a malformed value 422 — both surface as `APIError.http` carrying the
    /// server's `detail`, which the caller shows inline.
    func updateUsername(_ username: String) async throws -> SessionUser {
        let response: SessionResponse = try await client.patch(
            "/v1/me", body: UpdateUsernameBody(username: username)
        )
        return response.data.user
    }

    /// Request an email change (`POST /v1/me/email`, 202). The server emails a
    /// confirmation link and returns the session with `pendingEmail` set — the
    /// address only goes live once that link is opened. `captchaToken` is the
    /// Cloudflare Turnstile token (validated server-side via siteverify, exactly
    /// as for the web client); `honeypot` is the off-screen bot trap, normally
    /// empty for a real user.
    func setEmail(
        _ email: String,
        captchaToken: String,
        honeypot: String = ""
    ) async throws -> SessionUser {
        let response: SessionResponse = try await client.post(
            "/v1/me/email",
            body: SetEmailBody(
                email: email, captchaToken: captchaToken, fmmHpToken: honeypot
            )
        )
        return response.data.user
    }

    /// Re-send the pending confirmation link (`POST /v1/me/email/resend`, 202).
    /// Also Turnstile-gated — generate a fresh token right before calling.
    func resendEmailConfirmation(
        captchaToken: String,
        honeypot: String = ""
    ) async throws -> SessionUser {
        let response: SessionResponse = try await client.post(
            "/v1/me/email/resend",
            body: ResendEmailBody(captchaToken: captchaToken, fmmHpToken: honeypot)
        )
        return response.data.user
    }

    /// Confirm an email-change token (`POST /v1/me/email/confirm`). Unlike the
    /// other methods here it returns the full `SessionResponse`: the token is
    /// the bearer credential, so the server rotates the caller's session to the
    /// token's owner and reports — via `merged` — any guest matches folded in,
    /// exactly like sign-in. That's why the confirm landing takes the whole
    /// response, not just the user.
    ///
    /// Classifies failure the same way `LoginService.consume` does — and reuses
    /// its `LoginConsumeError` — with one extra reading: the confirm endpoint's
    /// one coded 400 (`{"detail": {"code": "replaced", ...}}`, a link a newer
    /// resend superseded) surfaces as `.replaced` rather than `.rejected`,
    /// because its fix is opening the most recent email, not resending — a
    /// resend would kill the newer live link (#1616). Every other `4xx` is a
    /// rejected token (invalid, expired, already used) and terminal; anything
    /// else is transient and worth a retry. Keeping that boundary-typing in the
    /// service, not the view, is the convention the rest of the API layer
    /// follows.
    func confirmEmail(token: String, skipMerge: Bool = false) async throws -> SessionResponse {
        let result: Result<SessionResponse, ConfirmEmailCodedError>
        do {
            result = try await client.sendExpectingCodedError(
                "POST",
                "/v1/me/email/confirm",
                body: ConfirmEmailBody(token: token, skipMerge: skipMerge)
            )
        } catch let APIError.http(status, _) where (400..<500).contains(status) {
            // A 4xx whose body isn't the coded shape — the plain-string
            // "invalid or expired" detail every other dead link carries.
            throw LoginConsumeError.rejected
        } catch {
            throw LoginConsumeError.unreachable
        }
        switch result {
        case .success(let session):
            return session
        case let .failure(coded) where coded.detail.code == "replaced":
            throw LoginConsumeError.replaced
        case .failure:
            // A coded 400 this client has no screen for is still a rejection.
            throw LoginConsumeError.rejected
        }
    }
}

// MARK: - Request bodies
//
// Encoded with `APIClient`'s `.convertToSnakeCase` strategy, so `captchaToken`
// ships as `captcha_token` and `fmmHpToken` as `fmm_hp_token` — matching the
// pydantic `SetEmailRequest` / `CaptchaProtectedRequest` field names.

private struct UpdateUsernameBody: Encodable {
    let username: String
}

private struct SetEmailBody: Encodable {
    let email: String
    let captchaToken: String
    let fmmHpToken: String
}

private struct ResendEmailBody: Encodable {
    let captchaToken: String
    let fmmHpToken: String
}

private struct ConfirmEmailBody: Encodable {
    let token: String
    let skipMerge: Bool
}

/// The coded detail `POST /v1/me/email/confirm` carries on the one `400` whose
/// body is structured — a superseded link (#1616), mirroring the API's
/// `ConfirmEmailErrorDetail`. Decode-what-you-need: `message` is deliberately
/// unread, since a code this client recognises is one it already has a screen
/// for, and an unrecognised code falls back to `.rejected` anyway.
private struct ConfirmEmailCodedError: Decodable, Error {
    let detail: Detail

    struct Detail: Decodable {
        let code: String
        let message: String?
    }
}
