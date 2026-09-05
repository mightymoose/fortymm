import Foundation

/// Serializes single-use redemption and dismissal of its landing screen.
@MainActor
final class LinkSubmission {
    private var inFlight = false
    private var closing = false
    private var completion: CheckedContinuation<Void, Never>?

    func close(_ operation: () -> Void) async {
        guard !closing else { return }
        closing = true
        // Cancellation cannot undo a server-side redemption. Let the response
        // install its credentials before dismissal reloads the active session.
        if inFlight {
            await withCheckedContinuation { completion = $0 }
        }
        operation()
    }

    func run(_ operation: () async -> Void) async {
        guard !inFlight, !closing else { return }
        inFlight = true
        defer {
            inFlight = false
            completion?.resume()
            completion = nil
        }
        await operation()
    }
}
