import Foundation

/// Mirror of the API's `SessionResponse` (see `api/app/schemas/session.py`).
/// Decoded with `.convertFromSnakeCase`, so `confirmed_at` / `pending_email`
/// arrive as `confirmedAt` / `pendingEmail`.
struct SessionResponse: Decodable {
    let data: SessionData
    let merged: MergeSummary?
}

struct SessionData: Decodable {
    let user: SessionUser
}

struct SessionUser: Decodable {
    let username: String
    let permissions: [String]
    let email: String?
    let confirmedAt: String?
    let pendingEmail: String?
}

struct MergeSummary: Decodable {
    let matchesMoved: Int
}

/// Mirror of the API's `MergePreview` (`POST /v1/merge/preview`). A
/// side-effect-free look at an emailed link so the verify/confirm screens can
/// show a "bring N matches over?" gate before finalizing. ``isMerge`` is true
/// only when the link would fold a guest with matches into another account.
struct MergePreview: Decodable {
    let isMerge: Bool
    let ownerUsername: String?
    let guestUsername: String?
    let guestMatchesCount: Int
    var accountSwitch: AccountSwitchPreview? = nil
}

struct AccountSwitchPreview: Decodable {
    let fromUserId: String
    let fromUsername: String
    let toUsername: String
}

struct LinkCodedError: Decodable, Error {
    struct Detail: Decodable {
        let code: String
        let accountSwitch: AccountSwitchPreview?
    }
    let detail: Detail
}

extension SessionUser {
    /// Where the user sits in the guest → verified lifecycle. Mirrors
    /// `deriveEmailStatus` in `web-client/src/api/session.ts`.
    enum EmailStatus {
        case guest
        case pending
        case verified
    }

    var emailStatus: EmailStatus {
        if pendingEmail != nil { return .pending }
        if confirmedAt != nil { return .verified }
        if email != nil { return .pending }
        return .guest
    }
}
