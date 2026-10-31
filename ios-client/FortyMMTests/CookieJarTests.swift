import Foundation
import Testing
@testable import FortyMM

struct CookieJarTests {
    @Test func keepsACookieAndSendsIt() {
        let store = MemoryCookieStore()
        let jar = CookieJar(store: store)

        jar.apply(
            setCookie: ["__Host-fortymm_session=abc; HttpOnly; Max-Age=34560000; Path=/; SameSite=lax; Secure"]
        )

        #expect(jar.header == "__Host-fortymm_session=abc")
        #expect(store.saved == ["__Host-fortymm_session": "abc"])
    }

    @Test func readsCookiesFoldedIntoOneLine() {
        let jar = CookieJar(store: MemoryCookieStore(["__Host-fortymm_login": "state"]))

        jar.apply(
            setCookie: [
                "__Host-fortymm_session=new; Path=/; Secure; HttpOnly; Max-Age=34560000, "
                    + "__Host-fortymm_login=\"\"; expires=Sat, 31 Oct 2026 12:00:00 GMT; Max-Age=0; Path=/; Secure"
            ]
        )

        #expect(jar.header == "__Host-fortymm_session=new")
    }

    @Test func anExpiredCookieRemovesTheOneItHolds() {
        let store = MemoryCookieStore(["__Host-fortymm_session": "abc"])
        let jar = CookieJar(store: store)

        jar.apply(
            setCookie: ["__Host-fortymm_session=\"\"; expires=Sat, 31 Oct 2026 18:51:51 GMT; HttpOnly; Max-Age=0; Path=/; Secure"]
        )

        #expect(jar.header == nil)
        #expect(store.saved.isEmpty)
    }

    @Test func aPastExpiresWithoutMaxAgeRemovesTheCookie() {
        let store = MemoryCookieStore(["__Host-fortymm_login": "state"])
        let jar = CookieJar(store: store)

        jar.apply(
            setCookie: ["__Host-fortymm_login=\"\"; expires=Sat, 31 Oct 2026 12:00:00 GMT; Path=/; Secure"],
            now: Date(timeIntervalSince1970: 1_793_500_000)
        )

        #expect(jar.header == nil)
    }

    @Test func startsWithTheStoredCookies() {
        let jar = CookieJar(store: MemoryCookieStore(["b": "2", "a": "1"]))

        #expect(jar.header == "a=1; b=2")
    }
}
