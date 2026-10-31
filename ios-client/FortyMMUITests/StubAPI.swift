import Foundation
import Network

/// A local HTTP server that stands in for the API, so a UI test needs no
/// dev stack and never reaches production. It answers every request the same
/// way, or never.
final class StubAPI {
    enum Behavior {
        /// Accept each connection and never answer, so the app keeps waiting.
        case hold
        /// Answer every request with this status and no body.
        case status(Int)
    }

    let baseURL: URL
    private let listener: NWListener

    init(_ behavior: Behavior) throws {
        let queue = DispatchQueue(label: "StubAPI")
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = NWEndpoint.hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
        }
        listener.newConnectionHandler = { connection in
            connection.start(queue: queue)
            guard case .status(let status) = behavior else { return }
            connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { _, _, _, _ in
                let response = "HTTP/1.1 \(status) Stub\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                connection.send(content: Data(response.utf8), completion: .contentProcessed { _ in
                    connection.cancel()
                })
            }
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success, let port = listener.port else {
            throw URLError(.cannotConnectToHost)
        }
        baseURL = URL(string: "http://127.0.0.1:\(port.rawValue)")!
    }

    deinit {
        listener.cancel()
    }
}
