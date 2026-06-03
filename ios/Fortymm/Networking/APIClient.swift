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

    /// Name of the auth cookie the API sets and reads. Centralised so the send
    /// and capture sides can't drift.
    private static let sessionCookieName = "session"

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

    /// Bodyless POST for endpoints that take no payload (e.g. confirm/dispute).
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
        if let token = await tokens.token() {
            request.setValue(
                "\(Self.sessionCookieName)=\(token)",
                forHTTPHeaderField: "Cookie"
            )
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        await captureSessionCookie(from: http, url: url)
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

    /// FastAPI errors come back as `{"detail": "..."}` (or `{"detail": [...]}`
    /// for validation errors). Pull a human string out when we can.
    private static func detail(from data: Data) -> String? {
        struct StringDetail: Decodable { let detail: String }
        if let parsed = try? JSONDecoder().decode(StringDetail.self, from: data) {
            return parsed.detail
        }
        return nil
    }

    /// Pull a minted/rotated `session` cookie out of the response and persist
    /// it. The API only ever sets the single `session` cookie, so folding
    /// multiple Set-Cookie headers isn't a concern here.
    private func captureSessionCookie(from http: HTTPURLResponse, url: URL) async {
        guard let header = http.value(forHTTPHeaderField: "Set-Cookie") else {
            return
        }
        let cookies = HTTPCookie.cookies(
            withResponseHeaderFields: ["Set-Cookie": header],
            for: url
        )
        if let token = cookies.first(where: { $0.name == Self.sessionCookieName })?.value {
            await tokens.update(token)
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
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server returned an unexpected response."
        case let .http(status, detail):
            // Prefer the API's own message when it sent one.
            return detail ?? "The server returned an error (HTTP \(status))."
        case .decoding:
            return "Couldn't read the server's response."
        }
    }
}
