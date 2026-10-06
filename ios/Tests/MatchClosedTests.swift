import Foundation

private struct ClosedTestKeychain: SessionKeychain {
    let service = "match-closed-tests"
    let account = UUID().uuidString
    func save(_ value: String) -> Bool { true }
    func load() -> String? { nil }
    func delete() {}
}

private final class ClosedTransport: URLProtocol {
    static var body: Any = [:]
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: 409, httpVersion: nil, headerFields: nil
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: Self.body))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

/// #1651: the propose-result 409 for a finished match carries a stable code, so
/// the app can tell "the match is over" from the lock race without matching
/// English. The lock-race and negotiation 409s must keep their old behavior.
@main
struct MatchClosedTests {
    static func main() async {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ClosedTransport.self]
        let service = MatchService(client: APIClient(
            session: URLSession(configuration: configuration),
            tokens: SessionTokenStore(keychain: ClosedTestKeychain())
        ))
        let game = Game(a: 11, b: 5)

        func post() async -> Error? {
            do {
                _ = try await service.postResult(matchId: UUID(), games: [game])
                return nil
            } catch { return error }
        }

        ClosedTransport.body = [
            "detail": ["code": "match_closed", "message": "This match is no longer open to results."],
        ]
        if case MatchPostError.matchClosed? = await post() {
            print("PASS: coded match_closed 409 surfaces as MatchPostError.matchClosed")
        } else {
            preconditionFailure("A coded match_closed 409 must surface as MatchPostError.matchClosed")
        }

        ClosedTransport.body = [
            "detail": "A result is already being posted for this match. Refresh to see the latest.",
        ]
        if case let APIError.http(status, detail)? = await post() {
            precondition(status == 409 && detail?.contains("already being posted") == true,
                         "The lock-race 409 keeps its server text")
            print("PASS: lock-race 409 is unchanged")
        } else {
            preconditionFailure("The lock-race 409 must stay an APIError.http")
        }

        ClosedTransport.body = [
            "detail": ["viewer_state": "review", "your_turn": true, "message": "The result moved on."],
        ]
        if let error = await post(), case MatchPostError.matchClosed = error {
            preconditionFailure("A negotiation conflict has no code and must not read as match closed")
        }
        print("PASS: an uncoded object 409 is not match closed")

        ClosedTransport.body = [
            "detail": ["code": "something_else", "message": "Another reason."],
        ]
        if case let APIError.http(status, detail)? = await post() {
            precondition(status == 409 && detail == "Another reason.",
                         "An unknown code keeps its message as a plain HTTP error")
            print("PASS: an unknown code stays a plain HTTP error with its message")
        } else {
            preconditionFailure("An unknown code must stay an APIError.http")
        }

        func fixture(id: String, decided: Bool) -> FinalMatch {
            FinalMatch(
                id: id, you: MatchSeed.me, opponent: .unlistedOpponent, solo: true, games: [],
                bestOf: 3, rated: false, setsWon: SetScore(a: 0, b: 0), win: false,
                ratingOutcome: nil, when: "now", context: "Casual", decided: decided
            )
        }

        let completed = MatchClosedOutcome(refetched: fixture(id: "m-1651-final", decided: true))
        if case let .showFinal(match, message) = completed {
            precondition(match.id == "m-1651-final", "The final result is the refetched match")
            precondition(message == "This match has already finished. Here is the final result.",
                         "A completed refetch keeps today's message")
            print("PASS: a completed refetch shows the final result")
        } else {
            preconditionFailure("A completed refetch must show the final result")
        }

        let open = MatchClosedOutcome(refetched: fixture(id: "m-1651-voided", decided: false))
        if case let .stay(message) = open {
            precondition(message == "This match is no longer open to results.",
                         "A refetched match that is not final says it is closed to results")
            print("PASS: a refetched match that is not final stays on the score screen")
        } else {
            preconditionFailure("A refetched match that is not final must stay on the score screen")
        }
    }
}
