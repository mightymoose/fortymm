import Foundation

/// Thin URLSession wrapper for talking to the FortyMM API.
///
/// The API is cookie-based: `GET /v1/session` mints a `User` + token on first
/// hit and returns it in a `session` cookie. Rather than let URLSession persist
/// that cookie to a plaintext file in the app sandbox, we turn its cookie
/// handling off entirely and manage the token ourselves: read it from the
/// Keychain (`SessionTokenStore`), send it as the `Cookie` header, and capture
/// any `Set-Cookie` the server returns. Transport stays cookies (no backend
/// change); storage becomes the Keychain.
struct APIClient {
    /// Base URL of the API, chosen per build configuration.
    ///
    /// `FMM_API_BASE_URL` (set in the scheme's environment) wins when present —
    /// handy for pointing a local Xcode run at a dev stack
    /// (e.g. http://localhost:8080). Note this override only applies to runs
    /// launched from Xcode; it does not ship in a Release/TestFlight build.
    ///
    /// Otherwise the default is per-configuration. Production currently points
    /// at UAT until the prod backend is live — flip the `#else` branch to the
    /// real prod host when it exists.
    static let baseURL: URL = {
        if let override = ProcessInfo.processInfo.environment["FMM_API_BASE_URL"],
           let url = URL(string: override) {
            return url
        }
        return URL(string: defaultBaseURLString)!
    }()

    private static var defaultBaseURLString: String {
        #if DEBUG
        return "https://uat.fortymm.com"
        #else
        // Prod → UAT for now. Replace with the production host once it exists.
        return "https://uat.fortymm.com"
        #endif
    }

    static let shared = APIClient()

    /// Posted (from any request) when the API reports the caller's session was
    /// merged away on another device — `401` with `{"detail":{"code":
    /// "session_merged", ...}}`. `SessionStore` observes it and routes to
    /// sign-in. `userInfo` carries `"message"` and (optionally) `"email"`.
    static let sessionEndedNotification = Notification.Name("com.fortymm.sessionEnded")

    /// Name of the auth cookie the API sets and reads. Centralised so the send
    /// and capture sides can't drift.
    private static let sessionCookieName = "session"

    /// Double-submit CSRF defense (see `csrf_protect` in api/app/main.py): the
    /// API sets a non-HttpOnly `csrf_token` cookie alongside the session, and
    /// rejects any unsafe-method request that doesn't echo that value back in
    /// the `X-CSRF-Token` header. We capture the cookie and replay both on
    /// mutations. Safe (non-mutating) methods are exempt server-side.
    private static let csrfCookieName = "csrf_token"
    private static let csrfHeaderName = "X-CSRF-Token"
    private static let csrfSafeMethods: Set<String> = ["GET", "HEAD", "OPTIONS"]

    private let session: URLSession
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let tokens: SessionTokenStore

    init(
        session: URLSession = APIClient.makeSession(),
        tokens: SessionTokenStore = .shared
    ) {
        self.session = session
        self.tokens = tokens
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        decoder.dateDecodingStrategy = .custom(APIClient.decodeDate)
        self.decoder = decoder
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        self.encoder = encoder
    }

    /// A session with cookie handling disabled — nothing is read from or
    /// written to `HTTPCookieStorage`, so no token ever lands on disk outside
    /// the Keychain.
    static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.default
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }

    /// Create (or resume) the caller's session. Idempotent: with a stored token
    /// the server resolves the existing user; without one it mints a guest and
    /// returns a `Set-Cookie` we capture into the Keychain.
    func getSession() async throws -> SessionResponse {
        try await get("/v1/session")
    }

    // MARK: - Verbs

    func get<T: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> T {
        try await send("GET", path, query: query, body: Optional<Empty>.none)
    }

    func post<T: Decodable>(
        _ path: String,
        body: (some Encodable)? = Optional<Empty>.none
    ) async throws -> T {
        try await send("POST", path, body: body)
    }

    /// Bodyless POST for endpoints that take no payload (e.g. result acceptance).
    /// Mirrors `get`/`delete` by handing `send` a concrete `Optional<Empty>.none`
    /// — which also sidesteps a swift-frontend codegen crash seen when the
    /// defaulted opaque `body:` parameter above is resolved at a no-arg callsite.
    func post<T: Decodable>(_ path: String) async throws -> T {
        try await send("POST", path, body: Optional<Empty>.none)
    }

    func put<T: Decodable>(
        _ path: String,
        body: (some Encodable)? = Optional<Empty>.none
    ) async throws -> T {
        try await send("PUT", path, body: body)
    }

    func patch<T: Decodable>(
        _ path: String,
        body: (some Encodable)? = Optional<Empty>.none
    ) async throws -> T {
        try await send("PATCH", path, body: body)
    }

    func delete<T: Decodable>(_ path: String) async throws -> T {
        try await send("DELETE", path, body: Optional<Empty>.none)
    }

    /// Empty stand-in body for verbs that take no payload, so the generic
    /// `body:` parameter has a concrete type to bind against.
    private struct Empty: Encodable {}

    // MARK: - Core

    /// Single request path shared by every verb: attaches the session cookie,
    /// encodes the optional JSON body, captures any rotated cookie, surfaces the
    /// API's `{detail}` error message on non-2xx, and decodes the response.
    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (some Encodable)?
    ) async throws -> T {
        let base = APIClient.baseURL.appendingPathComponent(path)
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            do {
                request.httpBody = try encoder.encode(body)
            } catch {
                throw APIError.decoding(error)
            }
        }
        // Send the session and its CSRF companion as cookies. The server's
        // double-submit check compares the CSRF cookie against the header, so
        // both must be present and equal on mutations. `sentToken` is captured
        // so the response handling can tell whether a session-dropping reply
        // pertains to the token *this* request used (vs. one a newer sign-in
        // has since replaced).
        let sentToken = await tokens.token()
        let csrf = await tokens.csrfToken()
        let cookieHeader = [
            sentToken.map { "\(Self.sessionCookieName)=\($0)" },
            csrf.map { "\(Self.csrfCookieName)=\($0)" },
        ].compactMap { $0 }.joined(separator: "; ")
        if !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        if let csrf, !Self.csrfSafeMethods.contains(method) {
            request.setValue(csrf, forHTTPHeaderField: Self.csrfHeaderName)
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        // A merged-away guest's cookie still resolves server-side, so this 401
        // can land on *any* request. Handle it before the generic cookie capture
        // and make it token-aware: only drop the token + broadcast the sign-out
        // if the cookie this request sent is still the one we hold. Otherwise a
        // stale in-flight request — whose token a newer sign-in already replaced
        // — would wipe the *new* token and kick the user out of a live session.
        if http.statusCode == 401, let info = Self.mergedSessionInfo(from: data) {
            if await tokens.clearIfCurrent(sentToken) {
                var userInfo: [String: Any] = ["message": info.message]
                if let email = info.email { userInfo["email"] = email }
                NotificationCenter.default.post(
                    name: Self.sessionEndedNotification, object: nil, userInfo: userInfo
                )
                throw APIError.sessionMerged(message: info.message, email: info.email)
            }
            // Token already superseded — fail this request without disturbing the
            // current session.
            throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
        }
        await captureSessionCookie(from: http, url: url, sentToken: sentToken)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// FastAPI serialises datetimes as ISO-8601, usually with fractional
    /// seconds (`...T08:16:04.337123+00:00`). `ISO8601DateFormatter` won't
    /// parse fractional seconds by default, so try the fractional formatter
    /// first and fall back to the plain one.
    private static let iso8601Fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso8601Plain = ISO8601DateFormatter()

    private static func decodeDate(_ decoder: Decoder) throws -> Date {
        let raw = try decoder.singleValueContainer().decode(String.self)
        if let date = iso8601Fractional.date(from: raw) ?? iso8601Plain.date(from: raw) {
            return date
        }
        throw DecodingError.dataCorrupted(
            .init(codingPath: decoder.codingPath,
                  debugDescription: "Unrecognised date: \(raw)")
        )
    }

    /// FastAPI errors come back as `{"detail": "..."}` for hand-raised
    /// `HTTPException`s, or `{"detail": [{"loc": ..., "msg": "...", ...}]}` for
    /// request-validation (422) errors. Pull a human string out of either shape
    /// — mirrors `extractDetail` in web-client/src/api/client.ts; keep in
    /// lockstep. Without the array branch a 422 (e.g. a scoring rule the client
    /// doesn't mirror) leaks as the bare "HTTP 422" fallback (#446).
    private static func detail(from data: Data) -> String? {
        struct StringDetail: Decodable { let detail: String }
        if let parsed = try? JSONDecoder().decode(StringDetail.self, from: data) {
            return humanize(parsed.detail)
        }
        struct ValidationDetail: Decodable {
            struct Item: Decodable { let msg: String }
            let detail: [Item]
        }
        if let parsed = try? JSONDecoder().decode(ValidationDetail.self, from: data),
           let first = parsed.detail.first {
            return humanize(first.msg)
        }
        return nil
    }

    /// Strip pydantic's `"Value error, "` prefix from a validator message so the
    /// UI shows the rule ("A game cannot end in a tie.") rather than the raw
    /// framework wrapper (the iOS face of #151).
    private static func humanize(_ message: String) -> String {
        let prefix = "Value error, "
        return message.hasPrefix(prefix) ? String(message.dropFirst(prefix.count)) : message
    }

    /// Parse the structured `session_merged` 401 body — `{"detail":{"code":
    /// "session_merged","message":...,"email":...}}` — returning the message and
    /// the owning account's email (to prefill on sign-in). `nil` for any other 401.
    private static func mergedSessionInfo(from data: Data) -> (message: String, email: String?)? {
        struct Body: Decodable {
            struct Detail: Decodable {
                let code: String
                let message: String?
                let email: String?
            }
            let detail: Detail
        }
        guard let parsed = try? JSONDecoder().decode(Body.self, from: data),
              parsed.detail.code == "session_merged" else { return nil }
        return (
            parsed.detail.message ?? "Your session has ended. Sign in to continue.",
            parsed.detail.email
        )
    }

    /// Pull a minted/rotated `session` cookie (and its companion `csrf_token`)
    /// out of the response and persist them. The API sets both together and
    /// folds them into the comma-joined `Set-Cookie` header; both use `Max-Age`
    /// (no comma-bearing `Expires`), so `HTTPCookie` splits them cleanly.
    private func captureSessionCookie(
        from http: HTTPURLResponse, url: URL, sentToken: String?
    ) async {
        guard let header = http.value(forHTTPHeaderField: "Set-Cookie") else {
            return
        }
        let cookies = HTTPCookie.cookies(
            withResponseHeaderFields: ["Set-Cookie": header],
            for: url
        )
        if let session = cookies.first(where: { $0.name == Self.sessionCookieName }) {
            if session.value.isEmpty {
                // A clearing Set-Cookie. Drop the token only if it's still the
                // one this request sent, so a stale reply can't wipe a token a
                // newer sign-in already installed. (The merged-401 clear is
                // handled before this, token-aware; this guards any other path.)
                _ = await tokens.clearIfCurrent(sentToken)
            } else {
                await tokens.update(session.value)
            }
        }
        // Capture the CSRF token whenever the server (re)issues it — including
        // the self-heal reissue on a returning session, which carries no
        // `session` cookie of its own.
        if let csrf = cookies.first(where: { $0.name == Self.csrfCookieName }),
           !csrf.value.isEmpty {
            await tokens.updateCSRF(csrf.value)
        }
    }
}

extension Error {
    /// A user-facing message: the API's own `errorDescription` when present
    /// (e.g. `APIError`), otherwise the system description. Centralises the
    /// `(self as? LocalizedError)?.errorDescription ?? localizedDescription`
    /// dance used at every catch site.
    var fmMessage: String {
        (self as? LocalizedError)?.errorDescription ?? localizedDescription
    }
}

enum APIError: LocalizedError {
    case invalidResponse
    case http(status: Int, detail: String? = nil)
    case sessionMerged(message: String, email: String?)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server returned an unexpected response."
        case let .http(status, detail):
            // Prefer the API's own message when it sent one.
            return detail ?? "The server returned an error (HTTP \(status))."
        case let .sessionMerged(message, _):
            return message
        case .decoding:
            return "Couldn't read the server's response."
        }
    }
}
