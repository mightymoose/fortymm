import Foundation
import Testing
@testable import FortyMM

struct CookieJarTests {
    let url = URL(string: "http://localhost:5173")!

    @Test func keepsACookieAndSendsIt() {
        let store = MemoryCookieStore()
        let jar = CookieJar(store: store)

        jar.apply(
            setCookie: ["__Host-fortymm_session=abc; HttpOnly; Max-Age=34560000; Path=/; SameSite=lax; Secure"],
            from: url
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
            ],
            from: url
        )

        #expect(jar.header == "__Host-fortymm_session=new")
    }

    @Test func anExpiredCookieRemovesTheOneItHolds() {
        let store = MemoryCookieStore(["__Host-fortymm_session": "abc"])
        let jar = CookieJar(store: store)

        jar.apply(
            setCookie: ["__Host-fortymm_session=\"\"; expires=Sat, 31 Oct 2026 18:51:51 GMT; HttpOnly; Max-Age=0; Path=/; Secure"],
            from: url
        )

        #expect(jar.header == nil)
        #expect(store.saved.isEmpty)
    }

    @Test func startsWithTheStoredCookies() {
        let jar = CookieJar(store: MemoryCookieStore(["b": "2", "a": "1"]))

        #expect(jar.header == "a=1; b=2")
    }
}
