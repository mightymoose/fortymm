/// Why a sign-in didn't finish, as `POST /v1/auth/app-finish` says.
enum SignInError: Equatable, Sendable {
    case cancelled
    case emailNotVerified
    case expired
    case failed

    /// Cancelling isn't a failure, so it gets no error colour.
    var isError: Bool { self != .cancelled }

    var title: String {
        switch self {
        case .cancelled: "Sign-in cancelled"
        case .emailNotVerified: "Verify your email first"
        case .expired: "Sign-in took too long"
        case .failed: "Sign-in didn’t work"
        }
    }

    var body: String {
        switch self {
        case .cancelled: "You didn’t finish signing in, so nothing changed."
        case .emailNotVerified:
            "Your sign-in provider hasn’t verified this email address. Verify it with them, then try again."
        case .expired: "A sign-in has 10 minutes to finish. Start again."
        case .failed: "Something went wrong, and nothing changed. Try again."
        }
    }
}

/// What finishing a sign-in did.
enum SignInOutcome: Equatable, Sendable {
    case signedIn
    case refused(SignInError)
}
