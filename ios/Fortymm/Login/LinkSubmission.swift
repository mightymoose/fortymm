import Foundation

/// Prevents overlapping single-use link submissions from one landing screen.
@MainActor
final class LinkSubmission {
    private var inFlight = false

    func run(_ operation: () async -> Void) async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        await operation()
    }
}
