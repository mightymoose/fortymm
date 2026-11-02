import Foundation
import Synchronization
@testable import FortyMM

/// A `CookieStore` that keeps the cookies in memory, in place of the Keychain.
final class MemoryCookieStore: CookieStore {
    private let cookies: Mutex<[String: String]>

    init(_ cookies: [String: String] = [:]) {
        self.cookies = Mutex(cookies)
    }

    var saved: [String: String] { cookies.withLock { $0 } }

    func load() -> [String: String] { saved }
    func save(_ cookies: [String: String]) { self.cookies.withLock { $0 = cookies } }
}

/// A `DeviceKeyStore` that keeps the key in memory, in place of the Keychain.
final class MemoryDeviceKeyStore: DeviceKeyStore {
    private let key = Mutex<DeviceKey?>(nil)

    func load() -> DeviceKey? { key.withLock { $0 } }

    func create() throws -> DeviceKey {
        let created = try DeviceKey.make()
        key.withLock { $0 = created }
        return created
    }

    func delete() { key.withLock { $0 = nil } }
}

/// Answers the requests of a `URLSession` that lists it, and records them.
final class StubURLProtocol: URLProtocol {
    struct Reply: Sendable {
        var status = 200
        var headers: [String: String] = [:]
        var body = ""
        var error: URLError?
    }

    struct Recorded: Sendable {
        let request: URLRequest
        let body: Data
    }

    private static let state = Mutex<(reply: Reply, recorded: [Recorded])>((Reply(), []))

    static func reply(_ reply: Reply) {
        state.withLock { $0 = (reply, []) }
    }

    static var recorded: [Recorded] { state.withLock { $0.recorded } }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBody ?? request.httpBodyStream.map(Self.read) ?? Data()
        let reply = Self.state.withLock { state in
            state.recorded.append(Recorded(request: request, body: body))
            return state.reply
        }
        if let error = reply.error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(
            url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: reply.headers
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        // Read until the end: hasBytesAvailable can be false before the body
        // arrives.
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

extension Account {
    static let guest = Account(
        id: UUID(uuidString: "00000000-0000-4000-8000-0000000000a1")!, kind: .guest, player: Player(id: "p1", displayName: "excited egret 387")
    )
    static let otherGuest = Account(
        id: UUID(uuidString: "00000000-0000-4000-8000-0000000000a2")!, kind: .guest, player: Player(id: "p2", displayName: "brave badger 214")
    )
    static let verified = Account(
        id: UUID(uuidString: "00000000-0000-4000-8000-0000000000a3")!, kind: .verified(email: "ann@example.com"), player: Player(id: "p3", displayName: "calm crane 512")
    )
}
