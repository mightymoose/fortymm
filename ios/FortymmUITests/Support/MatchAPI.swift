//
//  MatchAPI.swift
//  FortymmUITests
//
//  Direct-HTTP API helpers for provisioning match state ahead of a UI test,
//  from the *test process* rather than the app under test. Mirrors
//  `e2e/support/match-api.ts` (`mintGuest`, `findUserId`, `createMatch`,
//  `proposeResult`) for the same reason that file exists: seeding a
//  *two-party* rated match needs a second real participant, and driving that
//  through the app's own UI would mean a second simulator/app instance. One
//  side (guest A) is the app under test, minted by the app itself on launch;
//  the other side (guest B) is minted and driven entirely from here.
//
//  This intentionally does NOT go through `Networking/APIClient.swift` — that
//  file is app-target code (imports `SessionTokenStore`, the Keychain, etc.)
//  and the test target doesn't link the app target. The cookie handling below
//  mirrors it in miniature: no shared `HTTPCookieStorage`, a hand-rolled
//  `Cookie` header, and the double-submit CSRF defense (`app/main.py`'s
//  `csrf_protect`) — echo the non-HttpOnly `csrf_token` cookie back in
//  `X-CSRF-Token` on every unsafe-method write.
//

import Foundation

/// A provisioned guest: the session + CSRF token pair minted for it, plus the
/// identity fields a spec needs to wire up and assert against a match. A
/// class (not a struct) because `MatchAPI.send` updates the held tokens in
/// place after every response — mirroring `APIClient`'s own rotated-cookie
/// capture — so later calls on the same guest keep using its most current
/// tokens without every call site threading a fresh copy through.
final class APITestGuest {
    let baseURL: URL
    fileprivate let session: URLSession
    fileprivate(set) var sessionToken: String
    fileprivate(set) var csrfToken: String
    let userId: UUID
    /// The auto-assigned display username (also this guest's search key).
    let username: String

    fileprivate init(
        baseURL: URL, session: URLSession, sessionToken: String, csrfToken: String,
        userId: UUID, username: String
    ) {
        self.baseURL = baseURL
        self.session = session
        self.sessionToken = sessionToken
        self.csrfToken = csrfToken
        self.userId = userId
        self.username = username
    }
}

enum MatchAPITestError: Error, CustomStringConvertible {
    case http(status: Int, body: String)
    case missing(String)

    var description: String {
        switch self {
        case let .http(status, body):
            return "HTTP \(status): \(body)"
        case let .missing(what):
            return "missing \(what) in API response"
        }
    }
}

/// Direct HTTP helpers for the two-party seeding a rated-match XCUITest needs.
/// Every entry point is `async throws`, matching the app's own `APIClient`
/// call shape even though this is an independent implementation.
enum MatchAPI {
    private static let sessionCookieName = "session"
    private static let csrfCookieName = "csrf_token"
    private static let csrfHeaderName = "X-CSRF-Token"

    /// A `URLSession` with cookie handling off, one per guest — mirrors
    /// `APIClient.makeSession()` so two guests minted in the same test
    /// process never share a cookie jar.
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        return URLSession(configuration: config)
    }

    private struct EmptyBody: Encodable {}

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        return encoder
    }()

    /// Mint a fresh ephemeral guest: `GET /v1/session` creates a `User` and
    /// issues the session + CSRF cookies into a brand-new cookie jar.
    static func mintGuest(baseURL: URL) async throws -> APITestGuest {
        let session = makeSession()
        let url = baseURL.appendingPathComponent("/v1/session")
        let (data, http) = try await raw(
            session, url, "GET",
            body: Optional<EmptyBody>.none, sessionToken: nil, csrfToken: nil
        )
        guard (200..<300).contains(http.statusCode) else {
            throw MatchAPITestError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        guard let tokens = cookies(from: http, url: baseURL) else {
            throw MatchAPITestError.missing("session/csrf_token cookies on session mint")
        }
        struct SessionResponse: Decodable {
            struct Payload: Decodable {
                struct User: Decodable { let id: UUID; let username: String }
                let user: User
            }
            let data: Payload
        }
        let decoded = try decoder.decode(SessionResponse.self, from: data)
        return APITestGuest(
            baseURL: baseURL, session: session,
            sessionToken: tokens.session, csrfToken: tokens.csrf,
            userId: decoded.data.user.id, username: decoded.data.user.username
        )
    }

    /// A player as the opponent typeahead reports it: id (for `createMatch`)
    /// and `rating` — `nil` for a player who has never finished a rated match
    /// (`PlayerReadDTO.rating` in the app target is the same `Double?`; see
    /// #1359). Exposing `rating` here is what lets a spec assert the
    /// "genuinely fresh guest" precondition instead of assuming it.
    struct FoundPlayer {
        let id: UUID
        let rating: Double?
    }

    /// Resolve a user via the opponent typeahead (`GET /v1/players/search`).
    /// Ephemeral guests are searchable (only tombstoned/merged users are
    /// excluded), so this is how one guest names another as an opponent
    /// without any claim/sign-in step.
    static func findPlayer(searcher: APITestGuest, username: String) async throws -> FoundPlayer {
        var components = URLComponents(url: searcher.baseURL.appendingPathComponent("/v1/players/search"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "q", value: username)]
        let (data, http) = try await raw(
            searcher.session, components.url!, "GET",
            body: Optional<EmptyBody>.none, sessionToken: searcher.sessionToken, csrfToken: searcher.csrfToken
        )
        try updateTokens(on: searcher, from: http, url: searcher.baseURL)
        guard (200..<300).contains(http.statusCode) else {
            throw MatchAPITestError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        struct PlayerRow: Decodable { let id: UUID; let username: String; let rating: Double? }
        let players = try decoder.decode([PlayerRow].self, from: data)
        guard let match = players.first(where: { $0.username == username }) else {
            throw MatchAPITestError.missing("player \"\(username)\" in search results")
        }
        return FoundPlayer(id: match.id, rating: match.rating)
    }

    /// Create a rated match (`POST /v1/matches`) with `creator` on side 1 and
    /// `opponentId` on side 2. Returns the new match's id.
    static func createMatch(creator: APITestGuest, opponentId: UUID, bestOf: Int, rated: Bool) async throws -> UUID {
        struct Body: Encodable {
            let opponentUserId: UUID
            let bestOf: Int
            let rated: Bool
        }
        struct CreatedMatch: Decodable { let id: UUID }
        let body = Body(opponentUserId: opponentId, bestOf: bestOf, rated: rated)
        let (data, _) = try await send(
            "POST", "/v1/matches", body: body, guest: creator, expect: 201
        )
        return try decoder.decode(CreatedMatch.self, from: data).id
    }

    /// One game of a proposed board (canonical side-1/side-2 axis).
    struct ResultGame: Encodable {
        let gameNumber: Int
        let side1Points: Int
        let side2Points: Int

        enum CodingKeys: String, CodingKey {
            case gameNumber = "game_number"
            case side1Points = "side_1_points"
            case side2Points = "side_2_points"
        }
    }

    /// Propose a result (`POST .../results`) — the first verb of the
    /// propose/accept negotiation. On a rated two-human match the result
    /// stays *standing* until the opposing side accepts. Returns the
    /// standing result's id, the concurrency token the acceptance names.
    static func proposeResult(proposer: APITestGuest, matchId: UUID, games: [ResultGame]) async throws -> UUID {
        struct Body: Encodable { let games: [ResultGame] }
        struct Negotiation: Decodable {
            struct Standing: Decodable { let id: UUID }
            let standingResult: Standing?
        }
        struct Details: Decodable { let negotiation: Negotiation }
        let (data, _) = try await send(
            "POST", "/v1/matches/\(matchId.uuidString)/results",
            body: Body(games: games), guest: proposer, expect: 201
        )
        let details = try decoder.decode(Details.self, from: data)
        guard let id = details.negotiation.standingResult?.id else {
            throw MatchAPITestError.missing(
                "standing_result.id on the proposed match — was it created with rated: true and a real opponent?"
            )
        }
        return id
    }

    // MARK: - Wire mechanics

    /// A single verb request that requires a specific success status, mirroring
    /// the shape `MatchAPI`'s callers want (`createMatch`, `proposeResult`).
    private static func send<Body: Encodable>(
        _ method: String, _ path: String, body: Body?, guest: APITestGuest, expect: Int
    ) async throws -> (Data, HTTPURLResponse) {
        let url = guest.baseURL.appendingPathComponent(path)
        let (data, http) = try await raw(
            guest.session, url, method,
            body: body, sessionToken: guest.sessionToken, csrfToken: guest.csrfToken
        )
        try updateTokens(on: guest, from: http, url: guest.baseURL)
        guard http.statusCode == expect else {
            throw MatchAPITestError.http(status: http.statusCode, body: String(data: data, encoding: .utf8) ?? "")
        }
        return (data, http)
    }

    /// Build, send, and return the raw response for one request — the shared
    /// core `mintGuest` (no tokens yet) and every authenticated call route
    /// through, so the `Cookie`/`X-CSRF-Token` attachment logic lives once.
    private static func raw<Body: Encodable>(
        _ session: URLSession, _ url: URL, _ method: String,
        body: Body?, sessionToken: String?, csrfToken: String?
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try encoder.encode(body)
        }
        let cookieHeader = [
            sessionToken.map { "\(sessionCookieName)=\($0)" },
            csrfToken.map { "\(csrfCookieName)=\($0)" },
        ].compactMap { $0 }.joined(separator: "; ")
        if !cookieHeader.isEmpty {
            request.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }
        let safeMethods: Set<String> = ["GET", "HEAD", "OPTIONS"]
        if let csrfToken, !safeMethods.contains(method) {
            request.setValue(csrfToken, forHTTPHeaderField: csrfHeaderName)
        }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MatchAPITestError.missing("HTTPURLResponse for \(method) \(url)")
        }
        return (data, http)
    }

    /// Pull a minted/rotated `session` cookie (and its CSRF companion) out of
    /// a raw response, without mutating any guest yet — used by `mintGuest`,
    /// which has no `APITestGuest` to update until it decodes the identity.
    private static func cookies(from http: HTTPURLResponse, url: URL) -> (session: String, csrf: String)? {
        guard let header = http.value(forHTTPHeaderField: "Set-Cookie") else { return nil }
        let cookies = HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: url)
        guard let session = cookies.first(where: { $0.name == sessionCookieName }),
              let csrf = cookies.first(where: { $0.name == csrfCookieName })
        else { return nil }
        return (session.value, csrf.value)
    }

    /// Capture any rotated `session`/`csrf_token` cookie a response carries,
    /// updating the guest in place so its next call uses the fresh tokens.
    private static func updateTokens(on guest: APITestGuest, from http: HTTPURLResponse, url: URL) throws {
        guard let tokens = cookies(from: http, url: url) else { return }
        guest.sessionToken = tokens.session
        guest.csrfToken = tokens.csrf
    }
}
