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
        // NB: on the objc-era Foundation (iOS 17, our minimum target)
        // `.convertFromSnakeCase` also rewrites the keys *inside* a
        // `[String: …]` dictionary (`in_progress` → `inProgress`);
        // swift-foundation (iOS 18+) does not. So DTOs must not decode a raw
        // `[String: …]` map keyed by a server string and then look it up by that
        // string — it silently reads nil on iOS 17. Model such maps as a typed
        // value that re-canonicalises keys at the boundary (see `StatusCounts`).
        // Named struct fields are unaffected on either OS.
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
        if let ended = await tokens.endedSession() {
            throw APIError.sessionMerged(message: ended.message, email: ended.email)
        }
        return try await get("/v1/session")
    }

    func startNewGuest() async throws -> SessionResponse {
        await tokens.prepareNewGuest()
        // Only this explicit choice bypasses the persisted recovery gate.
        return try await get("/v1/session")
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

    /// DELETE endpoints that return 204 have no JSON body to decode.
    func deleteWithoutResponse(_ path: String) async throws {
        let (data, http) = try await perform("DELETE", path, body: Optional<Empty>.none)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
        }
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
        let (data, http) = try await perform(method, path, query: query, body: body)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }

    /// Status-aware request that distinguishes a 2xx success body from a `409
    /// Conflict` body, letting a caller read the structured conflict payload the
    /// generic `send` path discards (it keeps only a humanized `detail` string).
    ///
    /// Used for the conditional score writes (create/update), where a `409`
    /// carries a `GameScoreConflictDTO` with the row as it actually stands:
    /// - `2xx` → decode `Success` → `.success`
    /// - `409` → decode `Conflict` from the body → `.failure`
    /// - any other non-2xx → throw the same `APIError` `send` would.
    ///
    /// Shares `perform` with `send`, so auth, cookie capture, the merged-session
    /// 401, and the JSON decoder configuration are identical. `method` is a
    /// parameter (not hardcoded) so it serves both `POST .../scores/new` and
    /// `PUT .../games/{n}/scores`. The body is required (no defaulted opaque
    /// body) since these callsites always send one.
    func sendExpectingConflict<Success: Decodable, Conflict: Decodable>(
        _ method: String,
        _ path: String,
        body: some Encodable
    ) async throws -> Result<Success, Conflict> {
        let (data, http) = try await perform(method, path, body: body)
        if (200..<300).contains(http.statusCode) {
            do {
                return .success(try decoder.decode(Success.self, from: data))
            } catch {
                throw APIError.decoding(error)
            }
        }
        if http.statusCode == 409 {
            do {
                return .failure(try decoder.decode(Conflict.self, from: data))
            } catch {
                throw APIError.decoding(error)
            }
        }
        throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
    }

    /// Status-aware request that distinguishes a 2xx success body from a `4xx`
    /// body whose `detail` is a structured object (`{"detail": {"code": ...,
    /// "message": ...}}`), letting a caller read the coded reason the generic
    /// `send` path discards (it keeps only a humanized `detail` string, and a
    /// coded body yields none at all).
    ///
    /// Used for the email confirm, whose `400` carries `{code: "replaced"}`
    /// for a link a newer resend superseded (#1616) — a reason that must not
    /// read as "expired or already used", whose fix is opening the most
    /// recent email rather than resending.
    /// - `2xx` → decode `Success` → `.success`
    /// - `4xx` whose body decodes as `CodedError` → `.failure`
    /// - any other non-2xx → throw the same `APIError` `send` would.
    ///
    /// Shares `perform` with `send`, so auth, cookie capture, the merged-session
    /// 401, and the JSON decoder configuration are identical. Only a body that
    /// actually parses as the coded shape returns `.failure` — a plain-string
    /// detail (every other dead link), a 422 validation array, or an empty body
    /// falls through to `APIError`, so the caller's existing 4xx handling keeps
    /// working.
    func sendExpectingCodedError<Success: Decodable, CodedError: Decodable>(
        _ method: String,
        _ path: String,
        body: some Encodable
    ) async throws -> Result<Success, CodedError> {
        let (data, http) = try await perform(method, path, body: body)
        if (200..<300).contains(http.statusCode) {
            do {
                return .success(try decoder.decode(Success.self, from: data))
            } catch {
                throw APIError.decoding(error)
            }
        }
        if (400..<500).contains(http.statusCode),
           let coded = try? decoder.decode(CodedError.self, from: data) {
            return .failure(coded)
        }
        throw APIError.http(status: http.statusCode, detail: Self.detail(from: data))
    }

    /// Build, send, and post-process a request up to (but not including) the
    /// 2xx/decoding step: attaches auth cookies + CSRF, encodes the optional JSON
    /// body, handles the merged-session 401, and captures any rotated cookie.
    /// Returns the raw `(Data, HTTPURLResponse)` so callers can branch on status
    /// — `send` applies the 2xx guard + decode, `sendExpectingConflict` splits
    /// success from a 409 body.
    private func perform(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (some Encodable)?
    ) async throws -> (Data, HTTPURLResponse) {
        let prepared = try await makeRequest(method, path, query: query, body: body)
        let (data, response) = try await session.data(for: prepared.request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        try await handleSessionDrop(http: http, body: data, sentToken: prepared.sentToken)
        await captureSessionCookie(from: http, url: prepared.url, sentToken: prepared.sentToken)
        return (data, http)
    }

    /// A request with its auth attached, plus the two things the response side
    /// needs back: the resolved URL (for cookie capture) and the session token
    /// the request actually carried.
    private struct PreparedRequest {
        let request: URLRequest
        let url: URL
        /// The token this request sent, so a session-dropping reply can be
        /// matched against the token we still hold (vs. one a newer sign-in has
        /// since replaced).
        let sentToken: String?
    }

    /// Build an authenticated request: query, JSON body, session + CSRF cookies,
    /// and the CSRF header on mutating methods.
    ///
    /// Shared by the buffered `perform` and the streaming `openStream`, so the
    /// hand-rolled `Cookie` header this client depends on (URLSession's own
    /// cookie handling is off — see `makeSession`) can't be present on one and
    /// missing on the other. A streaming request without it is anonymous, and
    /// `/v1/stream` answers that with a 401.
    private func makeRequest(
        _ method: String,
        _ path: String,
        query: [URLQueryItem] = [],
        body: (some Encodable)?,
        accept: String = "application/json"
    ) async throws -> PreparedRequest {
        let base = APIClient.baseURL.appendingPathComponent(path)
        guard var components = URLComponents(url: base, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidResponse
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidResponse }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(accept, forHTTPHeaderField: "Accept")
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
        // both must be present and equal on mutations.
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
        return PreparedRequest(request: request, url: url, sentToken: sentToken)
    }

    /// Throw if this response says the caller's session was merged away.
    ///
    /// A merged-away guest's cookie still resolves server-side, so this 401 can
    /// land on *any* request. It is handled before the generic cookie capture
    /// and is token-aware: only drop the token + broadcast the sign-out if the
    /// cookie this request sent is still the one we hold. Otherwise a stale
    /// in-flight request — whose token a newer sign-in already replaced — would
    /// wipe the *new* token and kick the user out of a live session.
    private func handleSessionDrop(
        http: HTTPURLResponse, body: Data, sentToken: String?
    ) async throws {
        guard http.statusCode == 401, let info = Self.mergedSessionInfo(from: body) else {
            return
        }
        if await tokens.endIfCurrent(sentToken, message: info.message, email: info.email) {
            var userInfo: [String: Any] = ["message": info.message]
            if let email = info.email { userInfo["email"] = email }
            NotificationCenter.default.post(
                name: Self.sessionEndedNotification, object: nil, userInfo: userInfo
            )
            throw APIError.sessionMerged(message: info.message, email: info.email)
        }
        // Token already superseded — fail this request without disturbing the
        // current session.
        throw APIError.http(status: http.statusCode, detail: Self.detail(from: body))
    }

    // MARK: - Streaming

    /// How much of a refused stream's body to read before giving up on finding
    /// a `{"detail": …}` in it. The refusals are small JSON objects; a bound
    /// keeps a hostile or misconfigured upstream from streaming an "error page"
    /// into memory forever.
    private static let errorBodyByteLimit = 64 * 1024

    /// Open a long-lived streaming `GET` and hand back its bytes, un-consumed.
    ///
    /// This is how `Realtime/RealtimeConnection` reads `GET /v1/stream`. It goes
    /// through `APIClient` rather than a private `URLSession` for one concrete
    /// reason beyond convention: this client turns URLSession's cookie storage
    /// **off** (`makeSession`) and attaches the Keychain-held session cookie by
    /// hand, so a stream opened on any other session is anonymous and refused.
    /// Routing it through `makeRequest` also means the CSRF companion cookie,
    /// the structured `session_merged` 401, the rotated-cookie capture, and the
    /// API's own error messages all behave exactly as they do everywhere else.
    ///
    /// A non-2xx never becomes a stream: the (bounded) body is drained so the
    /// API's `detail` survives, and the same `APIError` any other call would
    /// throw is thrown here.
    ///
    /// The response only needs its *headers* to return, so this resolves as
    /// soon as the server accepts — the body arrives through the returned
    /// sequence. Cancelling the consuming `Task` ends the iteration and the
    /// request with it.
    func openStream(_ path: String) async throws -> URLSession.AsyncBytes {
        let prepared = try await makeRequest(
            "GET", path, body: Optional<Empty>.none, accept: "text/event-stream"
        )
        var request = prepared.request
        // A stream is never a cache hit, and a caching proxy holding one open
        // is worse than useless.
        request.cachePolicy = .reloadIgnoringLocalCacheData

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = await Self.drain(bytes, limit: Self.errorBodyByteLimit)
            try await handleSessionDrop(http: http, body: body, sentToken: prepared.sentToken)
            throw APIError.http(status: http.statusCode, detail: Self.detail(from: body))
        }
        await captureSessionCookie(from: http, url: prepared.url, sentToken: prepared.sentToken)
        return bytes
    }

    /// Read at most `limit` bytes off a refused stream's body. Never throws —
    /// a body that fails mid-read just yields what arrived, because the caller
    /// is already on its way to throwing the status.
    private static func drain(_ bytes: URLSession.AsyncBytes, limit: Int) async -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            // Partial body is fine; `detail(from:)` simply won't find anything.
        }
        return data
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
        struct CodedDetail: Decodable {
            struct Detail: Decodable { let message: String }
            let detail: Detail
        }
        if let parsed = try? JSONDecoder().decode(CodedDetail.self, from: data) {
            return humanize(parsed.detail.message)
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
              ["session_merged", "session_ended"].contains(parsed.detail.code) else { return nil }
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
