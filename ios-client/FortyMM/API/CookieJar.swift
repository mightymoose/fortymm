import Foundation
import Security
import Synchronization

/// Where the jar keeps its cookies between launches, as name to value.
protocol CookieStore: Sendable {
    func load() -> [String: String]
    func save(_ cookies: [String: String])
}

/// The API's own cookies, `__Host-fortymm_session` and `__Host-fortymm_login`.
///
/// The app keeps them itself rather than in `HTTPCookieStorage`, because
/// Apple's storage drops a `Secure` cookie that comes over http, so the dev
/// stack's account would never persist.
final class CookieJar: Sendable {
    private let store: any CookieStore
    private let cookies: Mutex<[String: String]>

    init(store: any CookieStore) {
        self.store = store
        cookies = Mutex(store.load())
    }

    /// The `Cookie` header for the cookies the jar holds, or nil without any.
    var header: String? {
        let cookies = cookies.withLock { $0 }
        guard !cookies.isEmpty else { return nil }
        return cookies.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: "; ")
    }

    func value(named name: String) -> String? {
        cookies.withLock { $0[name] }
    }

    /// Applies a response's `Set-Cookie` values. A cookie that has already
    /// expired, such as one with `Max-Age=0`, removes the one the jar holds.
    /// A value may hold several cookies folded into one line, as
    /// `HTTPURLResponse` folds them.
    ///
    /// It parses the values itself. `HTTPCookie`'s parser changes between
    /// iOS versions, and iOS 26 drops a `Secure` cookie for an http URL.
    func apply(setCookie values: [String], now: Date = .now) {
        let parsed = values.flatMap(Self.unfold).compactMap { SetCookie($0, now: now) }
        guard !parsed.isEmpty else { return }
        let updated = cookies.withLock { cookies in
            for cookie in parsed {
                cookies[cookie.name] = cookie.expired ? nil : cookie.value
            }
            return cookies
        }
        store.save(updated)
    }

    /// The cookies of a value that may fold several into one line. A fold is
    /// a comma before the next `name=`. The comma in an `expires` date is
    /// followed by a day number and a space, so it never matches.
    private static func unfold(_ value: String) -> [String] {
        value.split(separator: /,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/).map(String.init)
    }
}

/// One `Set-Cookie` value: its name and value, and whether it has already
/// expired. `Max-Age` wins over `Expires`, as RFC 6265 says.
private struct SetCookie {
    let name: String
    let value: String
    let expired: Bool

    init?(_ line: String, now: Date) {
        let parts = line.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }
        guard let pair = parts.first, let equals = pair.firstIndex(of: "=") else { return nil }
        name = String(pair[..<equals])
        value = String(pair[pair.index(after: equals)...]).trimmingCharacters(in: CharacterSet(charactersIn: "\""))
        guard !name.isEmpty else { return nil }

        var maxAge: Int?
        var expires: Date?
        for attribute in parts.dropFirst() {
            let keyValue = attribute.split(separator: "=", maxSplits: 1).map(String.init)
            let attributeValue = keyValue.dropFirst().first ?? ""
            switch keyValue.first?.lowercased() {
            case "max-age": maxAge = Int(attributeValue)
            case "expires": expires = Self.httpDate().date(from: attributeValue)
            default: break
            }
        }
        if let maxAge {
            expired = maxAge <= 0
        } else if let expires {
            expired = expires <= now
        } else {
            expired = false
        }
    }

    private static func httpDate() -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "GMT")
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return formatter
    }
}

/// Keeps the cookies in the Keychain, one item per API base URL, so a dev
/// stack's session never goes to production or the other way round.
struct KeychainCookieStore: CookieStore {
    let account: String

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.fortymm.ios-client.cookies",
            kSecAttrAccount as String: account,
        ]
    }

    func load() -> [String: String] {
        var query = query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: AnyObject?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data,
              let cookies = try? JSONDecoder().decode([String: String].self, from: data)
        else { return [:] }
        return cookies
    }

    func save(_ cookies: [String: String]) {
        guard let data = try? JSONEncoder().encode(cookies) else { return }
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecItemNotFound {
            SecItemAdd(query.merging(attributes) { $1 } as CFDictionary, nil)
        }
    }
}
