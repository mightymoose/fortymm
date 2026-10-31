/// The account of a valid session. A guest has no email and a verified
/// account always has one, so the kind carries it.
struct Account: Equatable, Sendable {
    enum Kind: Equatable, Sendable {
        case guest
        case verified(email: String)
    }

    let id: String
    let kind: Kind
    let player: Player
}

/// The player an account plays as.
struct Player: Equatable, Sendable {
    let id: String
    let displayName: String

    /// The initials of the display name's first two words, e.g. `EE` for
    /// `excited egret 387`.
    var initials: String {
        displayName.split(separator: " ").prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}
