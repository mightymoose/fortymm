import Foundation
import Testing
@testable import FortyMM

/// An `AccountAPI` that answers from scripted results and records its calls.
actor FakeAPI: AccountAPI {
    var sessions: [Result<Account, Failure>]
    var logoutResult: Result<Void, Failure> = .success(())
    var beginResult: Result<URL, Failure> = .success(URL(string: "http://localhost/oidc/authorize")!)
    var finishResult: Result<SignInOutcome, Failure> = .success(.signedIn)
    private(set) var calls: [String] = []
    private(set) var callbacks: [URL] = []

    init(sessions: [Result<Account, Failure>]) {
        self.sessions = sessions
    }

    func script(
        sessions: [Result<Account, Failure>]? = nil,
        logout: Result<Void, Failure>? = nil,
        begin: Result<URL, Failure>? = nil,
        finish: Result<SignInOutcome, Failure>? = nil
    ) {
        if let sessions { self.sessions = sessions }
        if let logout { logoutResult = logout }
        if let begin { beginResult = begin }
        if let finish { finishResult = finish }
    }

    func startSession() async throws(Failure) -> Account {
        calls.append("startSession")
        return try sessions.removeFirst().get()
    }

    func logout() async throws(Failure) {
        calls.append("logout")
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
}

@MainActor
struct AppModelTests {
    let callback = URL(string: "fortymm://sign-in?code=c1&state=s1")!

    func ready(_ account: Account = .guest) async -> (AppModel, FakeAPI) {
        let api = FakeAPI(sessions: [.success(account)])
        let model = AppModel(api: api)
        await model.start()
        return (model, api)
    }

    @Test func startsASession() async {
        let (model, _) = await ready()

        #expect(model.phase == .ready(.guest))
    }

    @Test func aFailedStartShowsTheFailureAndCanTryAgain() async {
        let api = FakeAPI(sessions: [.failure(.rateLimited(retryAt: nil)), .success(.guest)])
        let model = AppModel(api: api)

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
        #expect(await api.calls == ["startSession", "beginSignIn", "finishSignIn", "startSession"])
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
        #expect(await api.calls == ["startSession", "beginSignIn"])
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
        #expect(await api.calls == ["startSession", "logout"])
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
