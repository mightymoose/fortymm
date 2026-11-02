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

    /// The registration of the device's key with the account of the last
    /// session that started. A sign-out waits for it, so a registration
    /// that answers late can't bring back a key after its sign-out.
    @ObservationIgnored private(set) var keyRegistration: Task<Void, Never>?

    private let api: any AccountAPI
    private let keys: any DeviceKeyStore
    private let deviceLabel: String

    init(api: any AccountAPI, keys: any DeviceKeyStore, deviceLabel: String) {
        self.api = api
        self.keys = keys
        self.deviceLabel = deviceLabel
    }

    /// Starts or resumes the session. Without a session cookie, that starts
    /// a guest account. Then it registers the device's key in the
    /// background, so the screen never waits for it.
    func start() async {
        phase = .starting
        do {
            let account = try await api.startSession()
            phase = .ready(account)
            let previous = keyRegistration
            keyRegistration = Task {
                await previous?.value
                await registerKey(for: account)
            }
        } catch {
            phase = .failed(error)
        }
    }

    /// Registers the device's key, or a new one, with the account. A failure
    /// changes nothing on screen: a hall with no signal is normal, and the
    /// next start tries again. The server answers 200 for a key the account
    /// already has, so registering on every start needs no local record.
    private func registerKey(for account: Account) async {
        // A key that another account owns, or that was revoked, is no use
        // to this account. Its replacement gets one try.
        for _ in 0..<2 {
            do {
                let key = try keys.load() ?? keys.create()
                let proof = try RegistrationProof.make(key: key, account: account.id)
                switch try await api.registerSigningKey(key.publicKey, proof: proof, label: deviceLabel) {
                case .registered:
                    return
                case .revoked, .ownedElsewhere:
                    keys.delete()
                }
            } catch {
                return
            }
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
        await keyRegistration?.value
        let key = keys.load()
        do {
            try await api.logout(signingKey: key?.publicKey.kid)
            keys.delete()
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
