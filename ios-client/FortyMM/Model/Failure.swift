import Foundation

/// What a failed request means for the person, so a screen can say what to
/// do. It mirrors the web client's `classifyFailure()`.
enum Failure: Error, Equatable {
    /// The API never answered, or a proxy said it can't reach it.
    case unreachable
    /// The person's network started too many guest accounts. `retryAt` comes
    /// from `Retry-After`.
    case rateLimited(retryAt: Date?)
    case broken

    /// The Worker answers 503 without an API origin, and Cloudflare answers
    /// 502 or 504 when the API doesn't. Each means the API can't be reached.
    init(status: Int, retryAfter: String?, now: Date = .now) {
        switch status {
        case 429: self = .rateLimited(retryAt: Self.parseRetryAfter(retryAfter, now: now))
        case 502, 503, 504: self = .unreachable
        default: self = .broken
        }
    }

    /// Retry-After is either a number of seconds or an HTTP date.
    static func parseRetryAfter(_ value: String?, now: Date = .now) -> Date? {
        guard let value = value?.trimmingCharacters(in: .whitespaces), !value.isEmpty else { return nil }
        if let seconds = Double(value) { return now.addingTimeInterval(seconds) }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter.date(from: value)
    }

    var title: String {
        switch self {
        case .unreachable: "Can’t reach FortyMM"
        case .rateLimited: "Wait a minute, then try again"
        case .broken: "Something went wrong"
        }
    }

    var sentence: String {
        switch self {
        case .unreachable:
            "Our server isn’t answering. It may be starting up, or your connection may be down. Check your connection, then try again."
        case .rateLimited:
            "Your network sent a lot of requests in a short time, so we paused it for a minute."
        case .broken:
            "FortyMM hit an error loading this page. Try again. If it keeps happening, tell us what you were doing."
        }
    }
}
