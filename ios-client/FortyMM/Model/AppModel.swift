import Foundation
import Observation

/// The app's state: where the session is, and the sign-in and sign-out in
/// flight. Views read it and call its actions.
@Observable @MainActor
final class AppModel {
    enum Phase: Equatable {
        case starting
        case ready(Account)
        case failed(Failure)
        case signedOut
    }

    enum SignInState: Equatable {
        case idle
        case signingIn
    }

    enum SignOutState: Equatable {
        case idle
        case signingOut
        case failed
    }

    /// Opens the provider's page and returns the URL it sent back to the
    /// app, or nil if the person closed the page.
    typealias Authenticate = @MainActor (URL) async throws -> URL?

    private(set) var phase: Phase = .starting
    private(set) var signInState: SignInState = .idle
    private(set) var signOutState: SignOutState = .idle
    /// Why the last sign-in didn't finish, until the person dismisses it.
    var signInError: SignInError?

    /// The last key registration, which waits for the one before it. Nothing
    /// on screen waits for it, so a slow network never holds up a button.
    private(set) var registration: Task<Void, Never>?

    private let api: any AccountAPI
    private let keys: DeviceKeys

    init(api: any AccountAPI, keys: DeviceKeys) {
        self.api = api
        self.keys = keys
    }

    /// Starts or resumes the session, then registers the device's signing
    /// key to its account. Without a session cookie, that starts a guest
    /// account.
    func start() async {
        phase = .starting
        let account: Account
        do {
            account = try await api.startSession()
        } catch {
            phase = .failed(error)
            return
        }
        phase = .ready(account)
        // One at a time, so two starts never both make a key.
        registration = Task { [previous = registration, keys, api] in
            await previous?.value
            await keys.register(to: account, with: api)
        }
    }

    func playAsGuest() async {
        signInError = nil
        await start()
    }

    func signIn(authenticate: Authenticate) async {
        guard signInState == .idle else { return }
        signInState = .signingIn
        defer { signInState = .idle }
        signInError = nil

        do {
            let authorizeURL = try await api.beginSignIn()
            // The person closed the page themselves, so there's nothing to say.
            guard let callback = try await authenticate(authorizeURL) else { return }
            if case .refused(let error) = try await api.finishSignIn(callback: callback) {
                signInError = error
                return
            }
        } catch {
            signInError = .failed
            return
        }
        await start()
    }

    func signOut() async {
        guard signOutState != .signingOut, case .ready = phase else { return }
        signOutState = .signingOut
        // A registration still in flight could land after the logout, and
        // leave a key the device has forgotten live on the account.
        await registration?.value
        do {
            // The API signs the key out before the device forgets it. The
            // key still verifies what it signed, so a queued result stays
            // good.
            try await api.logout(signingKey: keys.current)
            keys.forget()
            signOutState = .idle
            signInError = nil
            phase = .signedOut
        } catch {
            signOutState = .failed
        }
    }

    func dismissSignOutFailure() {
        if signOutState == .failed { signOutState = .idle }
    }
}
