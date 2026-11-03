import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// An `AccountAPI` that answers from scripted results and records its calls.
actor FakeAPI: AccountAPI {
    struct Registration {
        let key: SigningPublicKey
        let proof: Data
        let label: String
    }

    var sessions: [Result<Account, Failure>]
    var logoutResult: Result<Void, Failure> = .success(())
    var beginResult: Result<URL, Failure> = .success(URL(string: "http://localhost/oidc/authorize")!)
    var finishResult: Result<SignInOutcome, Failure> = .success(.signedIn)
    /// Answered in order, then `.registered`.
    var registerResults: [Result<KeyRegistration, Failure>] = []
    private(set) var calls: [String] = []
    private(set) var callbacks: [URL] = []
    private(set) var registrations: [Registration] = []
    private(set) var logoutKeys: [KeyId?] = []
    private var holdsRegistrations = false
    private var held: [CheckedContinuation<Void, Never>] = []

    init(sessions: [Result<Account, Failure>]) {
        self.sessions = sessions
    }

    func script(
        sessions: [Result<Account, Failure>]? = nil,
        logout: Result<Void, Failure>? = nil,
        begin: Result<URL, Failure>? = nil,
        finish: Result<SignInOutcome, Failure>? = nil,
        register: [Result<KeyRegistration, Failure>]? = nil
    ) {
        if let sessions { self.sessions = sessions }
        if let logout { logoutResult = logout }
        if let begin { beginResult = begin }
        if let finish { finishResult = finish }
        if let register { registerResults = register }
    }

    /// Holds each registration's answer until `releaseRegistrations()`.
    func holdRegistrations() {
        holdsRegistrations = true
    }

    func releaseRegistrations() {
        holdsRegistrations = false
        held.forEach { $0.resume() }
        held = []
    }

    func startSession() async throws(Failure) -> Account {
        calls.append("startSession")
        return try sessions.removeFirst().get()
    }

    func logout(signingKey: KeyId?) async throws(Failure) {
        calls.append("logout")
        logoutKeys.append(signingKey)
        try logoutResult.get()
    }

    func beginSignIn() async throws(Failure) -> URL {
        calls.append("beginSignIn")
        return try beginResult.get()
    }

    func finishSignIn(callback: URL) async throws(Failure) -> SignInOutcome {
        calls.append("finishSignIn")
        callbacks.append(callback)
        return try finishResult.get()
    }

    func registerSigningKey(_ key: SigningPublicKey, proof: Data, label: String) async throws(Failure) -> KeyRegistration {
        calls.append("registerSigningKey")
        registrations.append(Registration(key: key, proof: proof, label: label))
        if holdsRegistrations { await withCheckedContinuation { held.append($0) } }
        return try (registerResults.isEmpty ? .success(.registered) : registerResults.removeFirst()).get()
    }
}

@MainActor
struct AppModelTests {
    let callback = URL(string: "fortymm://sign-in?code=c1&state=s1")!

    let keys = MemoryKeyStore()

    func model(_ api: FakeAPI) -> AppModel {
        AppModel(api: api, keys: keys, deviceLabel: "Ann’s iPhone")
    }

    func ready(_ account: Account = .guest) async -> (AppModel, FakeAPI) {
        let api = FakeAPI(sessions: [.success(account)])
        let model = model(api)
        await model.start()
        await model.keyRegistration?.value
        return (model, api)
    }

    /// Whether `registration` registers its key with a valid proof for
    /// `account`.
    func proves(_ registration: FakeAPI.Registration, for account: Account) throws -> Bool {
        let publicKey = try #require(keys.publicKey(registration.key.kid))
        let protected = RegistrationProof.protectedHeader(kid: registration.key.kid)
        let payload = RegistrationProof.payload(account: account.id)
        let signature = Data(registration.proof.suffix(64))
        let expected = CBOR.tagged(18, .array([.bytes(protected), CBOR.emptyMap, .bytes(payload), .bytes(signature)]))
        let ecdsa = try P256.Signing.ECDSASignature(rawRepresentation: signature)
        let toBeSigned = RegistrationProof.toBeSigned(protected: protected, payload: payload)
        return registration.proof == expected.encoded && publicKey.isValidSignature(ecdsa, for: toBeSigned)
    }

    @Test func startsASession() async {
        let (model, _) = await ready()

        #expect(model.phase == .ready(.guest))
    }

    @Test func aFailedStartShowsTheFailureAndCanTryAgain() async {
        let api = FakeAPI(sessions: [.failure(.rateLimited(retryAt: nil)), .success(.guest)])
        let model = model(api)

        await model.start()
        #expect(model.phase == .failed(.rateLimited(retryAt: nil)))

        await model.start()
        #expect(model.phase == .ready(.guest))
    }

    @Test func signsIn() async {
        let (model, api) = await ready()
        await api.script(sessions: [.success(.verified)])

        await model.signIn { _ in callback }

        #expect(model.phase == .ready(.verified))
        #expect(model.signInError == nil)
        #expect(model.signInState == .idle)
        await model.keyRegistration?.value
        #expect(await api.calls == [
            "startSession", "registerSigningKey", "beginSignIn", "finishSignIn", "startSession", "registerSigningKey",
        ])
        #expect(await api.callbacks == [callback])
    }

    @Test func opensTheAuthorizeURL() async {
        let (model, _) = await ready()
        var opened: URL?

        await model.signIn { url in
            opened = url
            return nil
        }

        #expect(opened == URL(string: "http://localhost/oidc/authorize"))
    }

    @Test(arguments: [SignInError.cancelled, .emailNotVerified, .expired, .failed])
    func aRefusedSignInSaysWhy(error: SignInError) async {
        let (model, api) = await ready()
        await api.script(finish: .success(.refused(error)))

        await model.signIn { _ in callback }

        #expect(model.signInError == error)
        #expect(model.phase == .ready(.guest))
        #expect(await api.calls.last == "finishSignIn")
    }

    @Test func closingTheSignInPageSaysNothing() async {
        let (model, api) = await ready()

        await model.signIn { _ in nil }

        #expect(model.signInError == nil)
        #expect(model.signInState == .idle)
        #expect(await api.calls == ["startSession", "registerSigningKey", "beginSignIn"])
    }

    @Test func aSignInPageThatFailsSaysSo() async {
        let (model, _) = await ready()

        await model.signIn { _ in throw URLError(.cannotConnectToHost) }

        #expect(model.signInError == .failed)
    }

    @Test func aSignInThatCantStartSaysSo() async {
        let (model, api) = await ready()
        await api.script(begin: .failure(.unreachable))

        await model.signIn { _ in callback }

        #expect(model.signInError == .failed)
        #expect(model.phase == .ready(.guest))
    }

    @Test func aSignInThatCantFinishSaysSo() async {
        let (model, api) = await ready()
        await api.script(finish: .failure(.broken))

        await model.signIn { _ in callback }

        #expect(model.signInError == .failed)
        #expect(model.phase == .ready(.guest))
    }

    @Test func aNewSignInClearsTheLastError() async {
        let (model, api) = await ready()
        await api.script(finish: .success(.refused(.expired)))
        await model.signIn { _ in callback }

        await model.signIn { _ in nil }

        #expect(model.signInError == nil)
    }

    @Test(arguments: [Account.guest, .verified])
    func signsOut(account: Account) async {
        let (model, api) = await ready(account)

        await model.signOut()

        #expect(model.phase == .signedOut)
        #expect(model.signOutState == .idle)
        #expect(await api.calls == ["startSession", "registerSigningKey", "logout"])
    }

    @Test func aFailedSignOutStaysSignedIn() async {
        let (model, api) = await ready()
        let key = keys.current?.publicKey
        await api.script(logout: .failure(.unreachable))

        await model.signOut()

        #expect(model.phase == .ready(.guest))
        #expect(model.signOutState == .failed)
        #expect(keys.current?.publicKey == key)

        model.dismissSignOutFailure()
        #expect(model.signOutState == .idle)
    }

    @Test func playsAsANewGuestAfterSigningOut() async {
        let (model, api) = await ready()
        await model.signOut()
        await api.script(sessions: [.success(.otherGuest)])

        await model.playAsGuest()

        #expect(model.phase == .ready(.otherGuest))
    }

    @Test func registersTheDevicesKeyForTheAccount() async throws {
        let (model, api) = await ready()

        #expect(model.phase == .ready(.guest))
        let registration = try #require(await api.registrations.only)
        #expect(registration.key == keys.current?.publicKey)
        #expect(registration.label == "Ann’s iPhone")
        #expect(try proves(registration, for: .guest))
    }

    @Test func registersTheSameKeyOnTheNextStart() async throws {
        let (model, api) = await ready()
        await api.script(sessions: [.success(.guest)])

        await model.start()
        await model.keyRegistration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(registrations[0].key == registrations[1].key)
    }

    @Test(arguments: [KeyRegistration.ownedElsewhere, .revoked])
    func aKeyTheAccountCantUseIsReplaced(answer: KeyRegistration) async throws {
        let api = FakeAPI(sessions: [.success(.verified)])
        await api.script(register: [.success(answer)])
        let model = model(api)

        await model.start()
        await model.keyRegistration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(registrations[0].key != registrations[1].key)
        #expect(keys.current?.publicKey == registrations[1].key)
        #expect(try proves(registrations[1], for: .verified))
    }

    @Test func aReplacementKeyGetsOneTry() async {
        let api = FakeAPI(sessions: [.success(.guest)])
        await api.script(register: [.success(.ownedElsewhere), .success(.ownedElsewhere)])
        let model = model(api)

        await model.start()
        await model.keyRegistration?.value

        #expect(await api.registrations.count == 2)
        #expect(model.phase == .ready(.guest))
    }

    @Test func aFailedRegistrationLeavesTheAppReady() async {
        let api = FakeAPI(sessions: [.success(.guest)])
        await api.script(register: [.failure(.unreachable)])
        let model = model(api)

        await model.start()
        await model.keyRegistration?.value

        #expect(model.phase == .ready(.guest))
        #expect(await api.registrations.count == 1)
        #expect(keys.current != nil)
    }

    @Test func signOutSignsTheKeyOutThenDeletesIt() async throws {
        let (model, api) = await ready()
        let kid = try #require(keys.current?.publicKey.kid)

        await model.signOut()

        #expect(await api.logoutKeys == [kid])
        #expect(keys.current == nil)
    }

    @Test func signOutWaitsForTheRegistrationInFlight() async throws {
        let api = FakeAPI(sessions: [.success(.guest)])
        await api.holdRegistrations()
        let model = model(api)
        await model.start()
        while await api.registrations.isEmpty { await Task.yield() }

        let signOut = Task { await model.signOut() }
        for _ in 0..<20 { await Task.yield() }
        let callsWhileHeld = await api.calls
        #expect(!callsWhileHeld.contains("logout"))

        await api.releaseRegistrations()
        await signOut.value

        let registered = try #require(await api.registrations.first)
        #expect(await api.calls == ["startSession", "registerSigningKey", "logout"])
        #expect(await api.logoutKeys == [registered.key.kid])
        #expect(keys.current == nil)
    }

    @Test func aNewGuestAfterSignOutGetsANewKey() async throws {
        let (model, api) = await ready()
        await model.signOut()
        await api.script(sessions: [.success(.otherGuest)])

        await model.playAsGuest()
        await model.keyRegistration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(registrations[0].key.kid != registrations[1].key.kid)
        #expect(await api.logoutKeys == [registrations[0].key.kid])
        #expect(keys.current?.publicKey == registrations[1].key)
        #expect(try proves(registrations[1], for: .otherGuest))
    }
}

private extension Array {
    var only: Element? { count == 1 ? first : nil }
}

struct FailureTests {
    @Test func readsRetryAfterInSeconds() {
        let now = Date(timeIntervalSince1970: 1000)

        #expect(Failure(status: 429, retryAfter: "60", now: now) == .rateLimited(retryAt: now.addingTimeInterval(60)))
    }

    @Test func readsRetryAfterAsADate() {
        #expect(
            Failure.parseRetryAfter("Sat, 31 Oct 2026 18:51:51 GMT")
                == Date(timeIntervalSince1970: 1_793_472_711)
        )
    }

    @Test func otherStatusesAreBroken() {
        #expect(Failure(status: 500, retryAfter: nil) == .broken)
        #expect(Failure(status: 403, retryAfter: nil) == .broken)
    }
}

struct PlayerTests {
    @Test func initialsAreTheFirstTwoWords() {
        #expect(Player(id: "p", displayName: "excited egret 387").initials == "EE")
    }
}
