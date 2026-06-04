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
