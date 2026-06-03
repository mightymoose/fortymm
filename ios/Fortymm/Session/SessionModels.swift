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
