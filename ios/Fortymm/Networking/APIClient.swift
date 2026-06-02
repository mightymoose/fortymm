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

    private let session: URLSession
    private let decoder: JSONDecoder
    private let tokens: SessionTokenStore

    init(
        session: URLSession = APIClient.makeSession(),
        tokens: SessionTokenStore = .shared
    ) {
        self.session = session
        self.tokens = tokens
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        self.decoder = decoder
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

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let url = APIClient.baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token = await tokens.token() {
            request.setValue("session=\(token)", forHTTPHeaderField: "Cookie")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.invalidResponse
        }
        await captureSessionCookie(from: http, url: url)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError.http(status: http.statusCode)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
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
        if let token = cookies.first(where: { $0.name == "session" })?.value {
            await tokens.update(token)
        }
    }
}

enum APIError: LocalizedError {
    case invalidResponse
    case http(status: Int)
    case decoding(Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server returned an unexpected response."
        case let .http(status):
            return "The server returned an error (HTTP \(status))."
        case .decoding:
            return "Couldn't read the server's response."
        }
    }
}
