import Foundation

// Exercise the production HTTP client against a transport-boundary stub.
final class SessionTransport: URLProtocol {
    static var requestCount = 0
    static var status = 401
    static var body = #"{"detail":{"code":"session_ended","message":"You've been signed out. Sign in to continue."}}"#
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.requestCount += 1
        let response = HTTPURLResponse(url: request.url!, statusCode: Self.status,
                                       httpVersion: nil, headerFields: nil)!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(Self.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main struct SessionRecoveryTests {
    @MainActor static func main() async throws {
        let keychain = KeychainStore(service: "fortymm-session-tests", account: UUID().uuidString)
        defer {
            keychain.delete()
            UserDefaults.standard.removeObject(forKey: keychain.service + "." + keychain.account + ".ended")
        }
        let tokens = SessionTokenStore(keychain: keychain)
        await tokens.update("evicted-token")
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SessionTransport.self]
        let client = APIClient(session: URLSession(configuration: config), tokens: tokens)
        do {
            _ = try await client.getSession()
            fatalError("An evicted session must not load a guest")
        } catch APIError.sessionMerged(let message, _) {
            precondition(message == "You've been signed out. Sign in to continue.")
        }
        print("PASS: an evicted session reaches the native signed-out flow")
        let store = SessionStore(client: client)
        store.handle(URL(string: "https://fortymm.com/login/verifying?token=recovery-link")!)
        precondition(store.presentedDeepLink == nil,
                     "A cold-launch link must wait for session bootstrap")
        await store.load()
        precondition(store.pendingDeepLink == .login(token: "recovery-link"),
                     "Session eviction must not discard the link needed to sign back in")
        precondition(store.presentedDeepLink == .login(token: "recovery-link"))
        print("PASS: native recovery retains the incoming sign-in link")
        store.openMatch(UUID())
        precondition(store.presentedDeepLink == nil,
                     "A protected match must not cover signed-out recovery")
        // Simulate relaunch with the same durable credential store. A server
        // willing to mint a guest must never be reached until an explicit choice.
        SessionTransport.status = 200
        SessionTransport.body = #"{"data":{"user":{"username":"new-guest","permissions":[]}}}"#
        let relaunched = APIClient(session: URLSession(configuration: config),
                                   tokens: SessionTokenStore(keychain: keychain))
        do {
            _ = try await relaunched.getSession()
            fatalError("Relaunch silently minted a guest after eviction")
        } catch APIError.sessionMerged { }
        _ = try await relaunched.startNewGuest()
        let bootstrapping = SessionStore(client: relaunched)
        bootstrapping.handle(URL(string: "https://fortymm.com/confirm-email?token=confirmation")!)
        precondition(bootstrapping.presentedDeepLink == nil)
        await bootstrapping.load()
        precondition(bootstrapping.presentedDeepLink == .confirmEmail(token: "confirmation"))
        bootstrapping.presentedDeepLink = nil
        precondition(bootstrapping.pendingDeepLink == nil)
        print("PASS: native link presentation waits for a restored session")
        await tokens.clear()
        print("PASS: sign-out survives relaunch until an explicit new-guest choice")
        store.apply(bootstrapping.user!)
        store.handle(URL(string: "https://fortymm.com/login/verifying?token=changed-link")!)
        await tokens.update("revoked-after-preview")
        SessionTransport.status = 401
        SessionTransport.body = #"{"detail":{"code":"session_ended","message":"Your sign-in changed."}}"#
        await store.cancelDeepLink()
        precondition(store.user == nil && store.pendingDeepLink == nil,
                     "Cancel must refresh an invalidated source before returning to the shell")
        print("PASS: canceling native recovery refreshes the source identity")
        await tokens.clear()
        SessionTransport.status = 200
        SessionTransport.body = #"{"data":{"user":{"username":"new-guest","permissions":[]}}}"#
        let submission = LinkSubmission()
        SessionTransport.requestCount = 0
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<2 {
                group.addTask { @MainActor in
                    await submission.run {
                        _ = try? await LoginService(client: client).consume(token: "single-use")
                    }
                }
            }
        }
        precondition(SessionTransport.requestCount == 1,
                     "Concurrent approval taps must redeem a single-use link once")
        print("PASS: native duplicate approvals submit one HTTP request")
        let login = LoginService(client: client)
        SessionTransport.body = #"{"is_merge":false,"guest_matches_count":0,"account_switch":{"from_user_id":"alice-id","from_username":"alice","to_username":"bob"}}"#
        let preview = try await login.mergePreview(token: "bobs-link")
        precondition(preview.accountSwitch?.fromUsername == "alice")
        precondition(preview.accountSwitch?.toUsername == "bob")
        SessionTransport.status = 503
        do {
            _ = try await login.mergePreview(token: "bobs-link")
            fatalError("A failed preview must not authorize automatic merging")
        } catch APIError.http(let status, _) {
            precondition(status == 503)
        }
        SessionTransport.status = 409
        SessionTransport.body = #"{"detail":{"code":"account_switch_required","account_switch":{"from_user_id":"charlie-id","from_username":"charlie","to_username":"bob"}}}"#
        do {
            _ = try await login.consume(token: "bobs-link")
            fatalError("A changed sign-in requires fresh approval")
        } catch LoginConsumeError.accountSwitchRequired(let change) {
            precondition(change?.fromUsername == "charlie")
        }
        do {
            _ = try await ProfileService(client: client).confirmEmail(token: "bobs-link")
            fatalError("A confirmation link must require fresh approval too")
        } catch LoginConsumeError.accountSwitchRequired(let change) {
            precondition(change?.fromUsername == "charlie")
        }
        print("PASS: native link flows preserve account-switch previews and conflicts")
    }
}
