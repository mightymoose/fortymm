import Foundation

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
    }
}
