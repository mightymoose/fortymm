import Foundation
import HTTPTypes
import OpenAPIRuntime
import OpenAPIURLSession

/// The requests the app makes, in the app's own types. Every failure comes
/// out as a `Failure`.
protocol AccountAPI: Sendable {
    /// `POST /v1/session`: resumes the session, or starts a guest account.
    func startSession() async throws(Failure) -> Account
    /// `POST /v1/auth/logout`. With the device's key, the server signs the
    /// key out too.
    func logout(signingKey: KeyId?) async throws(Failure)
    /// `POST /v1/auth/app-login`: the provider's page to open.
    func beginSignIn() async throws(Failure) -> URL
    /// `POST /v1/auth/app-finish`, with the query of the URL that the
    /// provider sent back to the app.
    func finishSignIn(callback: URL) async throws(Failure) -> SignInOutcome
    /// `POST /v1/account/signing-keys`, with the key's registration proof
    /// for the session's account.
    func registerSigningKey(_ key: SigningPublicKey, proof: Data, label: String) async throws(Failure) -> KeyRegistration
}

/// What the server said about the device's key.
enum KeyRegistration: Equatable, Sendable {
    /// The session's account has the key, and it signs.
    case registered
    /// The account has the key, but someone reported the device
    /// compromised. It stays revoked.
    case revoked
    /// Another account has the key, for good.
    case ownedElsewhere
}

/// `AccountAPI` through the client generated from `api/openapi.json`. This
/// is the one place that turns the generated responses into the app's types.
struct FortyMMAPI: AccountAPI {
    let baseURL: URL
    private let client: Client

    init(baseURL: URL, jar: CookieJar, session: URLSession = Self.session()) {
        self.baseURL = baseURL
        client = Client(
            serverURL: baseURL.appending(path: "api"),
            transport: URLSessionTransport(configuration: .init(session: session)),
            middlewares: [CookieMiddleware(jar: jar)]
        )
    }

    /// A session that leaves cookies to `CookieMiddleware`.
    static func session(protocolClasses: [AnyClass]? = nil) -> URLSession {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        if let protocolClasses { configuration.protocolClasses = protocolClasses }
        return URLSession(configuration: configuration)
    }

    func startSession() async throws(Failure) -> Account {
        switch try await call({ try await client.startSession() }) {
        case .ok(let ok):
            let account = try decode { try ok.body.json.data.account }
            return try Account(account)
        case .tooManyRequests(let response):
            throw .rateLimited(retryAt: retryAt(seconds: response.headers.retryAfter))
        case .unsupportedMediaType:
            throw .broken
        case .undocumented(let status, let payload):
            throw Failure(status: status, retryAfter: payload.headerFields[.retryAfter])
        }
    }

    func logout(signingKey: KeyId?) async throws(Failure) {
        let request = Components.Schemas.LogoutRequest(signingKeyId: signingKey?.hex)
        switch try await call({ try await client.logout(body: .json(request)) }) {
        case .ok:
            return
        case .unsupportedMediaType, .unprocessableContent:
            throw .broken
        case .serviceUnavailable:
            throw .unreachable
        case .undocumented(let status, let payload):
            throw Failure(status: status, retryAfter: payload.headerFields[.retryAfter])
        }
    }

    func beginSignIn() async throws(Failure) -> URL {
        switch try await call({ try await client.appLogin() }) {
        case .ok(let ok):
            let authorizeURL = try decode { try ok.body.json.data.authorizeUrl }
            // In dev the provider is behind the web dev server's proxy, so
            // the URL is relative to it.
            guard let url = URL(string: authorizeURL, relativeTo: baseURL)?.absoluteURL else { throw .broken }
            return url
        case .tooManyRequests(let response):
            throw .rateLimited(retryAt: retryAt(seconds: response.headers.retryAfter))
        case .unsupportedMediaType:
            throw .broken
        case .serviceUnavailable:
            throw .unreachable
        case .undocumented(let status, let payload):
            throw Failure(status: status, retryAfter: payload.headerFields[.retryAfter])
        }
    }

    func finishSignIn(callback: URL) async throws(Failure) -> SignInOutcome {
        let query = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
        let request = Components.Schemas.AppFinishRequest(
            state: value("state"),
            code: value("code"),
            error: value("error")
        )
        switch try await call({ try await client.appFinish(body: .json(request)) }) {
        case .ok(let ok):
            let outcome = try decode { try ok.body.json.data.outcome }
            return SignInOutcome(outcome)
        case .unsupportedMediaType, .unprocessableContent:
            throw .broken
        case .serviceUnavailable:
            throw .unreachable
        case .undocumented(let status, let payload):
            throw Failure(status: status, retryAfter: payload.headerFields[.retryAfter])
        }
    }

    func registerSigningKey(_ key: SigningPublicKey, proof: Data, label: String) async throws(Failure) -> KeyRegistration {
        let request = Components.Schemas.RegisterKeyRequest(publicKey: key.coseKey.hex, proof: proof.hex, label: label)
        switch try await call({ try await client.registerSigningKey(body: .json(request)) }) {
        case .ok(let ok):
            let registered = try decode { try ok.body.json.data }
            return registered.revokedAt == nil ? .registered : .revoked
        case .conflict:
            return .ownedElsewhere
        case .unauthorized, .unsupportedMediaType, .unprocessableContent:
            throw .broken
        case .undocumented(let status, let payload):
            throw Failure(status: status, retryAfter: payload.headerFields[.retryAfter])
        }
    }

    private func retryAt(seconds: Int?) -> Date? {
        seconds.map { Date.now.addingTimeInterval(TimeInterval($0)) }
    }

    private func call<Output>(_ operation: () async throws -> Output) async throws(Failure) -> Output {
        do {
            return try await operation()
        } catch let error as ClientError where error.underlyingError is URLError {
            throw .unreachable
        } catch {
            throw .broken
        }
    }

    private func decode<Value>(_ read: () throws -> Value) throws(Failure) -> Value {
        do { return try read() } catch { throw .broken }
    }
}

private extension Account {
    init(_ account: Components.Schemas.SessionAccount) throws(Failure) {
        let kind: Kind
        switch account.kind {
        case .guest:
            kind = .guest
        case .verified:
            guard let email = account.email else { throw .broken }
            kind = .verified(email: email)
        }
        guard let id = UUID(uuidString: account.id) else { throw .broken }
        self.init(
            id: id,
            kind: kind,
            player: Player(id: account.player.id, displayName: account.player.displayName)
        )
    }
}

private extension SignInOutcome {
    init(_ outcome: Components.Schemas.AppSignInOutcome) {
        switch outcome {
        case .signedIn: self = .signedIn
        case .cancelled: self = .refused(.cancelled)
        case .emailNotVerified: self = .refused(.emailNotVerified)
        case .expired: self = .refused(.expired)
        case .failed: self = .refused(.failed)
        }
    }
}
