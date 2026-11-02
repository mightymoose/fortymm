import CryptoKit
import Foundation
import Testing
@testable import FortyMM

/// An `AccountAPI` that answers from scripted results and records its calls.
actor FakeAPI: AccountAPI {
    var sessions: [Result<Account, Failure>]
    var logoutResult: Result<Void, Failure> = .success(())
    var beginResult: Result<URL, Failure> = .success(URL(string: "http://localhost/oidc/authorize")!)
    var finishResult: Result<SignInOutcome, Failure> = .success(.signedIn)
    /// Each registration takes the next result, or `.registered` once none
    /// are left.
    var registrationResults: [Result<KeyRegistration.Outcome, Failure>] = []
    private(set) var calls: [String] = []
    private(set) var callbacks: [URL] = []
    private(set) var registrations: [KeyRegistration] = []
    private(set) var loggedOutKeys: [KeyID?] = []

    init(sessions: [Result<Account, Failure>]) {
        self.sessions = sessions
    }

    func script(
        sessions: [Result<Account, Failure>]? = nil,
        logout: Result<Void, Failure>? = nil,
        begin: Result<URL, Failure>? = nil,
        finish: Result<SignInOutcome, Failure>? = nil,
        registrations: [Result<KeyRegistration.Outcome, Failure>]? = nil
    ) {
        if let sessions { self.sessions = sessions }
        if let logout { logoutResult = logout }
        if let begin { beginResult = begin }
        if let finish { finishResult = finish }
        if let registrations { registrationResults = registrations }
    }

    func startSession() async throws(Failure) -> Account {
        calls.append("startSession")
        return try sessions.removeFirst().get()
    }

    func logout(signingKey: KeyID?) async throws(Failure) {
        calls.append("logout")
        loggedOutKeys.append(signingKey)
        try logoutResult.get()
    }

    func registerSigningKey(_ registration: KeyRegistration) async throws(Failure) -> KeyRegistration.Outcome {
        calls.append("registerSigningKey")
        registrations.append(registration)
        return try registrationResults.isEmpty ? .registered : registrationResults.removeFirst().get()
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
}

@MainActor
struct AppModelTests {
    let callback = URL(string: "fortymm://sign-in?code=c1&state=s1")!

    let keys = MemoryDeviceKeyStore()

    func model(_ api: FakeAPI) -> AppModel {
        AppModel(api: api, keys: DeviceKeys(store: keys, label: "iPhone"))
    }

    func ready(_ account: Account = .guest) async -> (AppModel, FakeAPI) {
        let api = FakeAPI(sessions: [.success(account)])
        let model = model(api)
        await model.start()
        await model.registration?.value
        return (model, api)
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
        await model.registration?.value

        #expect(model.phase == .ready(.verified))
        #expect(model.signInError == nil)
        #expect(model.signInState == .idle)
        #expect(await api.calls == ["startSession", "registerSigningKey", "beginSignIn", "finishSignIn", "startSession", "registerSigningKey"])
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
        await api.script(logout: .failure(.unreachable))

        await model.signOut()

        #expect(model.phase == .ready(.guest))
        #expect(model.signOutState == .failed)

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

    // MARK: The device's signing key

    func kid(_ registration: KeyRegistration) throws -> KeyID {
        try KeyID(bytes: Data(SHA256.hash(data: registration.publicKey)))
    }

    /// Whether the registration's proof is the one the API accepts: the
    /// fixed bytes for its key and `account`, signed by the key it sends.
    func proves(_ registration: KeyRegistration, for account: Account) throws -> Bool {
        let cose = registration.publicKey
        let key = SigningPublicKey(key: try P256.Signing.PublicKey(
            x963Representation: [0x04] + cose[8..<40] + cose[43..<75]
        ))
        let protected = RegistrationProof.protected(kid: key.kid)
        let payload = RegistrationProof.payload(account: account.id)
        let unsigned = CBOR.tagged(18, .array([.bytes(protected), .map([]), .bytes(payload), .bytes(Data(count: 64))])).encoded
        return key.coseKey == cose
            && registration.proof.dropLast(64) == unsigned.dropLast(64)
            && key.verifies(registration.proof.suffix(64), over: RegistrationProof.toBeSigned(protected: protected, payload: payload))
    }

    @Test func registersTheDevicesKeyOnceTheSessionStarts() async throws {
        let (model, api) = await ready()

        #expect(model.phase == .ready(.guest))
        let registration = try #require(await api.registrations.first)
        #expect(await api.registrations.count == 1)
        #expect(registration.label == "iPhone")
        #expect(try kid(registration) == keys.load()?.publicKey.kid)
        #expect(try proves(registration, for: .guest))
        #expect(try !proves(registration, for: .otherGuest))
    }

    @Test func eachStartRegistersTheSameKey() async throws {
        let (model, api) = await ready()
        await api.script(sessions: [.success(.guest)])

        await model.start()
        await model.registration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(try kid(registrations[0]) == kid(registrations[1]))
    }

    @Test func aNewGuestAccountAfterSignOutGetsANewKey() async throws {
        let (model, api) = await ready()
        let first = try kid(#require(await api.registrations.first))

        await model.signOut()
        #expect(await api.loggedOutKeys == [first])
        #expect(keys.load() == nil)

        await api.script(sessions: [.success(.otherGuest)])
        await model.playAsGuest()
        await model.registration?.value

        let second = try #require(await api.registrations.last)
        #expect(await api.registrations.count == 2)
        #expect(try kid(second) != first)
        #expect(try proves(second, for: .otherGuest))
    }

    @Test func aSignOutWaitsForTheRegistrationInFlight() async throws {
        let api = FakeAPI(sessions: [.success(.guest)])
        let model = model(api)

        await model.start()
        await model.signOut()

        #expect(await api.calls == ["startSession", "registerSigningKey", "logout"])
        #expect(try await api.loggedOutKeys == [kid(#require(api.registrations.first))])
    }

    @Test func aFailedSignOutKeepsTheKey() async throws {
        let (model, api) = await ready()
        let kid = keys.load()?.publicKey.kid
        await api.script(logout: .failure(.unreachable))

        await model.signOut()

        #expect(model.phase == .ready(.guest))
        #expect(keys.load()?.publicKey.kid == kid)
    }

    @Test func aSignInRegistersTheKeyToTheNewAccount() async throws {
        let (model, api) = await ready()
        await api.script(sessions: [.success(.verified)])

        await model.signIn { _ in callback }
        await model.registration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(try kid(registrations[1]) == kid(registrations[0]))
        #expect(try proves(registrations[1], for: .verified))
    }

    @Test(arguments: [KeyRegistration.Outcome.ownedElsewhere, .revoked])
    func aKeyThatCantSignForTheAccountIsReplaced(outcome: KeyRegistration.Outcome) async throws {
        let api = FakeAPI(sessions: [.success(.verified)])
        await api.script(registrations: [.success(outcome), .success(.registered)])
        _ = try keys.create()
        let model = model(api)

        await model.start()
        await model.registration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(try kid(registrations[1]) != kid(registrations[0]))
        #expect(try kid(registrations[1]) == keys.load()?.publicKey.kid)
        #expect(try proves(registrations[1], for: .verified))
    }

    @Test func aRegistrationThatFailsChangesNothingAndTheNextStartTriesAgain() async throws {
        let api = FakeAPI(sessions: [.success(.guest), .success(.guest)])
        await api.script(registrations: [.failure(.unreachable)])
        let model = model(api)

        await model.start()
        await model.registration?.value
        #expect(model.phase == .ready(.guest))
        let kid = keys.load()?.publicKey.kid

        await model.start()
        await model.registration?.value

        let registrations = await api.registrations
        #expect(registrations.count == 2)
        #expect(try self.kid(registrations[1]) == kid)
    }
}

struct DeviceKeyTests {
    /// The Keychain store the app uses, under an account no app run uses.
    let store = KeychainDeviceKeyStore(account: "tests-\(UUID().uuidString)")

    @Test func theKeychainKeepsTheKeyUntilItIsDeleted() throws {
        defer { store.delete() }
        #expect(store.load() == nil)

        let key = try store.create()

        let loaded = try #require(store.load())
        #expect(loaded.publicKey == key.publicKey)
        let message = Data("a result".utf8)
        #expect(key.publicKey.verifies(try loaded.sign(message), over: message))

        store.delete()
        #expect(store.load() == nil)
    }

    @Test func creatingAgainReplacesTheKey() throws {
        defer { store.delete() }
        let first = try store.create()

        let second = try store.create()

        #expect(second.publicKey != first.publicKey)
        #expect(store.load()?.publicKey == second.publicKey)
    }

    @Test func aKeyThatSignsGivesARawSignature() throws {
        let key = try DeviceKey.make()
        let message = Data("a result".utf8)

        let signature = try key.sign(message)

        #expect(signature.count == 64)
        #expect(key.publicKey.verifies(signature, over: message))
        #expect(key.publicKey.coseKey.count == 75)
    }
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
