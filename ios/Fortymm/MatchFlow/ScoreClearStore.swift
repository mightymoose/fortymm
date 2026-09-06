import Foundation
import Combine

/// Owns the clear request; the board is changed only by its completion callback.
@MainActor
final class ScoreClearStore: ObservableObject {
    @Published private(set) var failedGameNumber: Int?
    @Published private(set) var pendingGameNumber: Int?
    private var saveContinuation: CheckedContinuation<Void, Never>?

    func clear(gameNumber: Int, waitingForSave: Bool = false,
               delete: @escaping () async throws -> Void,
               didClear: @escaping () -> Void) async {
        guard pendingGameNumber == nil else { return }
        pendingGameNumber = gameNumber
        failedGameNumber = nil
        defer { pendingGameNumber = nil }
        if waitingForSave {
            await withCheckedContinuation { saveContinuation = $0 }
        }
        do {
            try await delete()
            didClear()
            failedGameNumber = nil
        } catch {
            failedGameNumber = gameNumber
        }
    }

    /// Both creates and updates must settle before removing their score.
    func saveFinished(gameNumber: Int) {
        guard pendingGameNumber == gameNumber else { return }
        saveContinuation?.resume()
        saveContinuation = nil
    }

    func dismissFailure(gameNumber: Int) {
        if failedGameNumber == gameNumber { failedGameNumber = nil }
    }
}
