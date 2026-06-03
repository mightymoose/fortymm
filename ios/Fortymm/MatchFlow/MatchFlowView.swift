import SwiftUI

/// Coordinator for the new-match flow: setup → live scoring → final detail.
/// Presented as a full-screen cover over the tab shell. UI-only — posting a
/// result just prepends to the shared in-memory store.
struct MatchFlowView: View {
    @EnvironmentObject private var store: MatchFlowStore
    /// Close the flow. `toMatches` = land on the Matches tab (vs. just dismiss).
    var onClose: (_ toMatches: Bool) -> Void

    private enum Step { case setup, score, detail }
    @State private var step: Step = .setup
    @State private var opponent: MatchPlayer?
    @State private var bestOf = 5
    @State private var rated = false
    @State private var final: FinalMatch?

    /// The config carried into scoring — derived from the setup selections.
    /// Solo (no opponent) is always unrated.
    private var config: MatchConfig {
        MatchConfig(opponent: opponent, bestOf: bestOf, rated: opponent == nil ? false : rated)
    }

    var body: some View {
        ZStack {
            FMColor.ink950.ignoresSafeArea()
            switch step {
            case .setup:
                NewMatchView(
                    opponent: $opponent, bestOf: $bestOf, rated: $rated,
                    onStart: start,
                    onCancel: { onClose(true) }
                )
                .transition(.opacity)
            case .score:
                ScoreEntryView(
                    config: config,
                    onPost: post,
                    onExit: { withAnimation { step = .setup } }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            case .detail:
                if let final {
                    MatchDetailView(
                        match: final,
                        onBack: { onClose(true) },
                        onAgain: resetForAnother
                    )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }
        }
    }

    private func start() {
        withAnimation { step = .score }
    }

    private func post(_ match: FinalMatch) {
        store.post(match)
        final = match
        withAnimation { step = .detail }
    }

    private func resetForAnother() {
        opponent = nil
        final = nil
        withAnimation { step = .setup }
    }
}
