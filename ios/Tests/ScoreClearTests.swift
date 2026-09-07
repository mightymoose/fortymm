import Foundation

private struct ClearTestKeychain: SessionKeychain {
    let service = "score-clear-tests"
    let account = UUID().uuidString
    func save(_ value: String) -> Bool { true }
    func load() -> String? { nil }
    func delete() {}
}

private final class ClearTransport: URLProtocol {
    static var detail = "Score not found."
    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        client?.urlProtocol(self, didReceive: HTTPURLResponse(
            url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil
        )!, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: try! JSONSerialization.data(withJSONObject: ["detail": Self.detail]))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}

@main
struct ScoreClearTests {
    @MainActor
    static func main() async {
        let store = ScoreClearStore()
        var score: [Int] = [11, 7]
        await store.clear(gameNumber: 1, delete: {
            throw URLError(.notConnectedToInternet)
        }, didClear: { score = [] })
        precondition(score == [11, 7], "A failed DELETE must preserve the saved score")
        precondition(store.failedGameNumber == 1, "The failed game must be shown for retry")
        print("PASS: failed clear preserves the score")

        await store.clear(gameNumber: 1, delete: {}, didClear: { score = [] })
        precondition(score.isEmpty && store.failedGameNumber == nil,
                     "A successful retry clears the score and the error")
        print("PASS: successful retry clears the score")

        score = [11, 7]
        var finishDelete: CheckedContinuation<Void, Never>?
        let pending = Task {
            await store.clear(gameNumber: 1, delete: {
                await withCheckedContinuation { finishDelete = $0 }
            }, didClear: { score = [] })
        }
        while finishDelete == nil { await Task.yield() }
        precondition(score == [11, 7], "Keep the score visible while DELETE is pending")
        var duplicateCalls = 0
        await store.clear(gameNumber: 1, delete: { duplicateCalls += 1 }, didClear: { score = [] })
        precondition(duplicateCalls == 0 && score == [11, 7], "Ignore duplicate clears while pending")
        finishDelete?.resume()
        await pending.value
        precondition(score.isEmpty, "Clear after the pending DELETE succeeds")
        print("PASS: pending clear preserves the score and rejects duplicate requests")

        score = [11, 7]
        var deleteCalls = 0
        let deferred = Task {
            await store.clear(gameNumber: 2, waitingForSave: true, delete: {
                deleteCalls += 1
                throw URLError(.notConnectedToInternet)
            }, didClear: { score = [] })
        }
        while store.pendingGameNumber == nil { await Task.yield() }
        precondition(deleteCalls == 0 && score == [11, 7], "Wait for the save before deleting")
        store.saveFinished(gameNumber: 1)
        precondition(deleteCalls == 0, "Another game's save must not release the clear")
        store.saveFinished(gameNumber: 2)
        await deferred.value
        precondition(deleteCalls == 1 && score == [11, 7] && store.failedGameNumber == 2,
                     "A deferred DELETE failure must also preserve the score")
        print("PASS: clear waits for its game's save and preserves the score on failure")

        store.dismissFailure(gameNumber: 1)
        precondition(store.failedGameNumber == 2, "Clearing another game must retain this error")
        store.dismissFailure(gameNumber: 2)
        precondition(store.failedGameNumber == nil, "A local clear must dismiss its old delete error")
        print("PASS: local clear dismisses only its game's error")

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ClearTransport.self]
        let service = MatchService(client: APIClient(
            session: URLSession(configuration: configuration),
            tokens: SessionTokenStore(keychain: ClearTestKeychain())
        ))
        score = [11, 7]
        await store.clear(gameNumber: 1, delete: {
            try await service.deleteGameScore(matchId: UUID(), gameNumber: 1)
        }, didClear: { score = [] })
        precondition(score.isEmpty && store.failedGameNumber == nil,
                     "An already-absent score satisfies the clear request")
        print("PASS: missing score is treated as cleared through the real API client")

        ClearTransport.detail = "Match not found."
        score = [11, 7]
        await store.clear(gameNumber: 1, delete: {
            try await service.deleteGameScore(matchId: UUID(), gameNumber: 1)
        }, didClear: { score = [] })
        precondition(score == [11, 7] && store.failedGameNumber == 1,
                     "An unrelated 404 must preserve the score")
        print("PASS: unrelated 404 remains a clear failure")

        var edited = ScoredGame(points: Game(a: 11, b: 8), sync: .saving(committedVersion: 1))
        let shouldResave = edited.completeSave(sent: Game(a: 11, b: 7), version: 2, clearing: true)
        precondition(!shouldResave && edited.sync == .failed(committedVersion: 2),
                     "A clear must defer a changed score without falsely marking it saved")
        precondition(GameWriteIntent.forWrite(edited.sync) == .update(expectedVersion: 2),
                     "A retained edit must retry against the newly committed version")
        print("PASS: clear preserves the unsaved edit and its retry version")

        var conflictDecisionNeeded = false
        let conflicted = ScoredGame(points: Game(a: 11, b: 8),
                                    sync: .conflict(committed: Game(a: 11, b: 9), version: 3))
        let clearingConflict = Task {
            await store.clear(gameNumber: 2, waitingForSave: true, delete: {
                throw URLError(.notConnectedToInternet)
            }, didClear: { preconditionFailure("Failed deletion cannot clear the conflict") }, didFail: {
                precondition(store.pendingGameNumber == nil, "Recovery starts after clearing settles")
                if case .conflict = conflicted.sync { conflictDecisionNeeded = true }
            })
        }
        while store.pendingGameNumber == nil { await Task.yield() }
        store.saveFinished(gameNumber: 2)
        await clearingConflict.value
        precondition(conflictDecisionNeeded, "A failed clear must restore the deferred conflict decision")
        print("PASS: failed deferred clear restores the conflict decision")
    }
}
