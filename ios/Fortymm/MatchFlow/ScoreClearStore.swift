import Foundation
import Combine

/// Owns the clear request; the board is changed only by its completion callback.
@MainActor
final class ScoreClearStore: ObservableObject {
    @Published private(set) var failedGameNumber: Int?
    @Published private(set) var failureMessage: String?
    @Published private(set) var pendingGameNumber: Int?
    private var saveContinuation: CheckedContinuation<Void, Never>?

    func clear(gameNumber: Int, waitingForSave: Bool = false,
               delete: @escaping () async throws -> Void,
               didClear: @escaping () -> Void,
               didFail: @escaping () -> Void = {}) async {
        guard pendingGameNumber == nil else { return }
        pendingGameNumber = gameNumber
        failedGameNumber = nil
        failureMessage = nil
        if waitingForSave {
            await withCheckedContinuation { saveContinuation = $0 }
        }
        do {
            try await delete()
            pendingGameNumber = nil
            didClear()
            failedGameNumber = nil
        } catch {
            pendingGameNumber = nil
            failedGameNumber = gameNumber
            failureMessage = error.fmMessage
            didFail()
        }
    }

    /// Both creates and updates must settle before removing their score.
    func saveFinished(gameNumber: Int) {
        guard pendingGameNumber == gameNumber else { return }
        saveContinuation?.resume()
        saveContinuation = nil
    }

    func dismissFailure(gameNumber: Int) {
        if failedGameNumber == gameNumber {
            failedGameNumber = nil
            failureMessage = nil
        }
    }
}
