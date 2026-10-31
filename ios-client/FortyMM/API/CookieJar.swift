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
    func apply(setCookie values: [String], from url: URL, now: Date = .now) {
        guard !values.isEmpty else { return }
        let parsed = HTTPCookie.cookies(
            withResponseHeaderFields: ["Set-Cookie": values.joined(separator: ", ")],
            for: url
        )
        let updated = cookies.withLock { cookies in
            for cookie in parsed {
                if let expires = cookie.expiresDate, expires <= now {
                    cookies[cookie.name] = nil
                } else {
                    cookies[cookie.name] = cookie.value
                }
            }
            return cookies
        }
        store.save(updated)
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
