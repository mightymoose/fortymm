import Foundation

/// Result of a client-side field check: ok plus an optional human-readable
/// reason. Mirrors the web client's `Validation` shape.
struct FieldValidation {
    let ok: Bool
    var error: String?

    static let valid = FieldValidation(ok: true, error: nil)
    static func invalid(_ error: String) -> FieldValidation {
        FieldValidation(ok: false, error: error)
    }
}

/// Client-side username/email rules. These exist for fast feedback only — the
/// API enforces the same pattern (`api/app/schemas/session.py`) and owns
/// uniqueness (409). Kept in lockstep with the web client's `validateUsername`
/// / `validateEmail` so the two clients reject the same inputs with the same
/// wording.
enum ProfileRules {
    static let usernameMin = 3
    static let usernameMax = 40

    /// Lowercase alphanumerics with optional dots/hyphens/underscores between,
    /// starting and ending with an alphanumeric.
    private static let usernamePattern = "^[a-z0-9](?:[a-z0-9._-]{1,38}[a-z0-9])?$"
    private static let emailPattern = #"^[^\s@]+@[^\s@]+\.[^\s@]{2,}$"#

    static func username(_ value: String) -> FieldValidation {
        if value.isEmpty { return .invalid("Username is required.") }
        // Surface the specific reason first — char checks before length checks,
        // so "Fo" reads as "uppercase isn't allowed" rather than "too short".
        if value.range(of: "[A-Z]", options: .regularExpression) != nil {
            return .invalid("Lowercase letters only — no uppercase.")
        }
        if value.range(of: #"\s"#, options: .regularExpression) != nil {
            return .invalid("No spaces — try a dot, hyphen or underscore instead.")
        }
        if value.count > usernameMax {
            return .invalid("No more than \(usernameMax) characters.")
        }
        if value.count < usernameMin {
            return .invalid("At least \(usernameMin) characters.")
        }
        if value.range(of: usernamePattern, options: .regularExpression) == nil {
            return .invalid(
                "Lowercase letters, numbers, dots, hyphens and underscores. "
                    + "Must start and end with a letter or number."
            )
        }
        return .valid
    }

    /// True when the value contains a character outside the allowed set — the
    /// signal for showing the error immediately rather than waiting for blur.
    static func usernameHasInvalidChar(_ value: String) -> Bool {
        value.range(of: "[^a-z0-9._-]", options: .regularExpression) != nil
    }

    static func email(_ value: String) -> FieldValidation {
        if value.isEmpty {
            return .invalid("Email is required to claim your account.")
        }
        if value.range(of: emailPattern, options: .regularExpression) == nil {
            return .invalid("That doesn't look like a valid email.")
        }
        return .valid
    }

    /// The error to surface for a field: a server error always wins; otherwise
    /// the client-side reason, but only once `show` is true (the caller gates
    /// this on blur and/or an obviously-bad character so we don't nag mid-type).
    static func displayError(
        _ validation: FieldValidation,
        serverError: String?,
        show: Bool
    ) -> String? {
        if let serverError { return serverError }
        return (show && !validation.ok) ? validation.error : nil
    }
}
