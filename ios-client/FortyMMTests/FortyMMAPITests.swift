import Foundation
import Testing
@testable import FortyMM

@Suite(.serialized)
struct FortyMMAPITests {
    let baseURL = URL(string: "http://localhost:5173")!
    let store = MemoryCookieStore()
    let api: FortyMMAPI

    init() {
        api = FortyMMAPI(
            baseURL: baseURL,
            jar: CookieJar(store: store),
            session: FortyMMAPI.session(protocolClasses: [StubURLProtocol.self])
        )
    }

    static let json = ["Content-Type": "application/json"]
    static let accountID = "0a9c5b1e-4f7d-4c2a-9b3e-6d8f1a2b3c4d"

    static func session(kind: String = "guest", email: String? = nil) -> String {
        let email = email.map { "\"\($0)\"" } ?? "null"
        return """
        {"data":{"account":{"id":"\(Self.accountID)","kind":"\(kind)","email":\(email),\
        "player":{"id":"p1","display_name":"excited egret 387"},"permissions":[]}}}
        """
    }

    @Test func startsASessionAndKeepsItsCookie() async throws {
        StubURLProtocol.reply(.init(
            headers: Self.json.merging(["Set-Cookie": "__Host-fortymm_session=abc; Path=/; Secure; HttpOnly; Max-Age=34560000"]) { $1 },
            body: Self.session()
        ))

        let account = try await api.startSession()

        #expect(account == Account(id: UUID(uuidString: Self.accountID)!, kind: .guest, player: Player(id: "p1", displayName: "excited egret 387")))
        let request = try #require(StubURLProtocol.recorded.first).request
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "http://localhost:5173/api/v1/session")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
        #expect(store.saved == ["__Host-fortymm_session": "abc"])
    }

    @Test func sendsTheCookiesItHolds() async throws {
        store.save(["__Host-fortymm_session": "abc"])
        let api = FortyMMAPI(
            baseURL: baseURL,
            jar: CookieJar(store: store),
            session: FortyMMAPI.session(protocolClasses: [StubURLProtocol.self])
        )
        StubURLProtocol.reply(.init(headers: Self.json, body: Self.session()))

        _ = try await api.startSession()

        let request = try #require(StubURLProtocol.recorded.first).request
        #expect(request.value(forHTTPHeaderField: "Cookie") == "__Host-fortymm_session=abc")
    }

    @Test func readsAVerifiedAccountsEmail() async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: Self.session(kind: "verified", email: "ann@example.com")))

        let account = try await api.startSession()

        #expect(account.kind == .verified(email: "ann@example.com"))
    }

    @Test func aTooManyRequestsSaysWhenToTryAgain() async {
        StubURLProtocol.reply(.init(
            status: 429,
            headers: Self.json.merging(["Retry-After": "30"]) { $1 },
            body: #"{"errors":[{"status":"429","title":"Too many guest accounts"}]}"#
        ))
        let before = Date.now

        let error = await #expect(throws: Failure.self) { try await api.startSession() }

        guard case .rateLimited(let retryAt?) = error else {
            Issue.record("\(String(describing: error)) isn't rate limited with a time")
            return
        }
        #expect(abs(retryAt.timeIntervalSince(before) - 30) < 5)
    }

    @Test(arguments: [502, 503, 504])
    func aProxyErrorMeansUnreachable(status: Int) async {
        StubURLProtocol.reply(.init(status: status))

        await #expect(throws: Failure.unreachable) { try await api.startSession() }
    }

    @Test func noResponseMeansUnreachable() async {
        StubURLProtocol.reply(.init(error: URLError(.notConnectedToInternet)))

        await #expect(throws: Failure.unreachable) { try await api.startSession() }
    }

    @Test func aServerErrorIsBroken() async {
        StubURLProtocol.reply(.init(status: 500))

        await #expect(throws: Failure.broken) { try await api.startSession() }
    }

    @Test func aBodyThatDoesntMatchTheSchemaIsBroken() async {
        StubURLProtocol.reply(.init(headers: Self.json, body: #"{"data":{}}"#))

        await #expect(throws: Failure.broken) { try await api.startSession() }
    }

    @Test func logoutForgetsTheSession() async throws {
        store.save(["__Host-fortymm_session": "abc"])
        let api = FortyMMAPI(
            baseURL: baseURL,
            jar: CookieJar(store: store),
            session: FortyMMAPI.session(protocolClasses: [StubURLProtocol.self])
        )
        StubURLProtocol.reply(.init(
            headers: Self.json.merging([
                "Set-Cookie": "__Host-fortymm_session=\"\"; expires=Sat, 31 Oct 2026 18:51:51 GMT; HttpOnly; Max-Age=0; Path=/; Secure",
            ]) { $1 },
            body: #"{"data":{"logout_url":"http://oidc:8080/default/v2/logout"}}"#
        ))

        try await api.logout(signingKey: nil)

        let request = try #require(StubURLProtocol.recorded.first).request
        #expect(request.url?.path == "/api/v1/auth/logout")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        #expect(store.saved.isEmpty)
    }

    @Test func logoutSignsOutTheDevicesKey() async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: #"{"data":{"logout_url":"http://oidc:8080/default/v2/logout"}}"#))
        let kid = try KeyID(bytes: Data(repeating: 0xab, count: 32))

        try await api.logout(signingKey: kid)

        let recorded = try #require(StubURLProtocol.recorded.first { $0.request.url?.path == "/api/v1/auth/logout" })
        let body = try JSONSerialization.jsonObject(with: recorded.body) as? [String: Any]
        #expect(body?["signing_key_id"] as? String == String(repeating: "ab", count: 32))
    }

    @Test func registersASigningKey() async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: Self.signingKey()))
        let registration = try KeyRegistration(key: TestKey.named("ann"), account: UUID(), label: "iPhone")

        let outcome = try await api.registerSigningKey(registration)

        #expect(outcome == .registered)
        let recorded = try #require(StubURLProtocol.recorded.first { $0.request.url?.path == "/api/v1/account/signing-keys" })
        #expect(recorded.request.httpMethod == "POST")
        let body = try JSONSerialization.jsonObject(with: recorded.body) as? [String: Any]
        #expect(body?["public_key"] as? String == registration.publicKey.hex)
        #expect(body?["proof"] as? String == registration.proof.hex)
        #expect(body?["label"] as? String == "iPhone")
    }

    @Test func aKeyAnotherAccountOwnsIsOwnedElsewhere() async throws {
        StubURLProtocol.reply(.init(
            status: 409,
            headers: Self.json,
            body: #"{"errors":[{"status":"409","title":"Another account registered this key"}]}"#
        ))
        let registration = try KeyRegistration(key: TestKey.named("ann"), account: UUID(), label: "iPhone")

        #expect(try await api.registerSigningKey(registration) == .ownedElsewhere)
    }

    @Test func aRegistrationWithNoResponseIsUnreachable() async throws {
        StubURLProtocol.reply(.init(error: URLError(.notConnectedToInternet)))
        let registration = try KeyRegistration(key: TestKey.named("ann"), account: UUID(), label: "iPhone")

        await #expect(throws: Failure.unreachable) { try await api.registerSigningKey(registration) }
    }

    /// The API writes microseconds, and no fraction when they are 0.
    static func signingKey(revokedAt: String = "null") -> String {
        """
        {"data":{"id":"\(String(repeating: "ab", count: 32))","label":"iPhone",\
        "created_at":"2026-11-02T12:00:00.123456Z","signed_out_at":"2026-11-02T13:00:00Z",\
        "revoked_at":\(revokedAt)}}
        """
    }

    @Test func aRevokedKeyIsRevoked() async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: Self.signingKey(revokedAt: #""2026-11-02T14:00:00.5Z""#)))
        let registration = try KeyRegistration(key: TestKey.named("ann"), account: UUID(), label: "iPhone")

        #expect(try await api.registerSigningKey(registration) == .revoked)
    }

    @Test func beginSignInResolvesARelativeAuthorizeURL() async throws {
        StubURLProtocol.reply(.init(
            headers: Self.json,
            body: #"{"data":{"authorize_url":"/oidc/default/authorize?state=s1"}}"#
        ))

        let url = try await api.beginSignIn()

        #expect(url.absoluteString == "http://localhost:5173/oidc/default/authorize?state=s1")
        #expect(StubURLProtocol.recorded.first?.request.url?.path == "/api/v1/auth/app-login")
    }

    @Test func beginSignInKeepsAnAbsoluteAuthorizeURL() async throws {
        StubURLProtocol.reply(.init(
            headers: Self.json,
            body: #"{"data":{"authorize_url":"https://auth.fortymm.com/authorize?state=s1"}}"#
        ))

        let url = try await api.beginSignIn()

        #expect(url.absoluteString == "https://auth.fortymm.com/authorize?state=s1")
    }

    @Test func finishSignInSendsTheCallbacksQuery() async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: #"{"data":{"outcome":"signed_in"}}"#))

        let outcome = try await api.finishSignIn(callback: URL(string: "fortymm://sign-in?code=c1&state=s1")!)

        #expect(outcome == .signedIn)
        let recorded = try #require(StubURLProtocol.recorded.first)
        #expect(recorded.request.url?.path == "/api/v1/auth/app-finish")
        #expect(recorded.request.value(forHTTPHeaderField: "Content-Type")?.hasPrefix("application/json") == true)
        let body = try JSONSerialization.jsonObject(with: recorded.body) as? [String: Any]
        #expect(body?["state"] as? String == "s1")
        #expect(body?["code"] as? String == "c1")
        #expect(body?["error"] == nil || body?["error"] is NSNull)
    }

    @Test(arguments: [
        ("cancelled", SignInOutcome.refused(.cancelled)),
        ("email_not_verified", .refused(.emailNotVerified)),
        ("expired", .refused(.expired)),
        ("failed", .refused(.failed)),
    ])
    func finishSignInReadsWhyItFailed(outcome: String, expected: SignInOutcome) async throws {
        StubURLProtocol.reply(.init(headers: Self.json, body: #"{"data":{"outcome":"\#(outcome)"}}"#))

        let result = try await api.finishSignIn(callback: URL(string: "fortymm://sign-in?error=access_denied&state=s1")!)

        #expect(result == expected)
    }

    @Test func anUnknownOutcomeFails() async {
        StubURLProtocol.reply(.init(headers: Self.json, body: #"{"data":{"outcome":"something_new"}}"#))

        await #expect(throws: Failure.self) {
            try await api.finishSignIn(callback: URL(string: "fortymm://sign-in?code=c1&state=s1")!)
        }
    }
}
