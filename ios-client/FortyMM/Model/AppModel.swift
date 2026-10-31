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

    private let api: any AccountAPI

    init(api: any AccountAPI) {
        self.api = api
    }

    /// Starts or resumes the session. Without a session cookie, that starts
    /// a guest account.
    func start() async {
        phase = .starting
        do {
            phase = .ready(try await api.startSession())
        } catch {
            phase = .failed(error)
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
        do {
            try await api.logout()
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
