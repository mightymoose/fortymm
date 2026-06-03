import SwiftUI

/// Coordinator for the new-match flow: setup → live scoring → final detail.
/// Presented as a full-screen cover over the tab shell.
///
/// Wired to the API: "Start match" creates the match server-side (capturing its
/// id), and "Post result" posts the canonical games and renders the detail from
/// the server's response — so a solo match shows "Final" and a two-player match
/// shows "Awaiting confirmation" honestly, rather than an optimistic result.
struct MatchFlowView: View {
    var service: MatchService = .shared
    /// Close the flow. `toMatches` = land on the Matches tab (vs. just dismiss).
    var onClose: (_ toMatches: Bool) -> Void

    private enum Step { case setup, score, detail }
    @State private var step: Step = .setup
    @State private var opponent: MatchPlayer?
    @State private var bestOf = 5
    @State private var rated = false

    /// Server match id, captured when the match is created on "Start match".
    @State private var matchId: UUID?
    @State private var final: FinalMatch?

    /// A create-or-post request is in flight (blocks the UI with a spinner).
    @State private var busy = false
    @State private var errorMessage: String?

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
                        initial: final,
                        onBack: { onClose(true) },
                        onAgain: resetForAnother
                    )
                    .transition(.move(edge: .trailing).combined(with: .opacity))
                }
            }

            if busy { FMBlockingSpinner() }
        }
        .alert(
            "Something went wrong",
            isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )
        ) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(errorMessage ?? "")
        }
    }

    /// Create the match server-side, then advance to scoring. Stays on setup
    /// (showing an alert) if creation fails, so the user can retry.
    private func start() {
        guard !busy else { return }
        busy = true
        Task {
            do {
                matchId = try await service.createMatch(
                    opponent: opponent, bestOf: bestOf, rated: config.rated
                )
                busy = false
                withAnimation { step = .score }
            } catch {
                busy = false
                errorMessage = Self.message(for: error)
            }
        }
    }

    /// Post the completed games for the match and show the server's result.
    private func post(_ games: [Game]) {
        guard let matchId, !busy else { return }
        busy = true
        Task {
            do {
                final = try await service.postResult(matchId: matchId, games: games)
                busy = false
                withAnimation { step = .detail }
            } catch {
                busy = false
                errorMessage = Self.message(for: error)
            }
        }
    }

    private func resetForAnother() {
        opponent = nil
        final = nil
        matchId = nil
        withAnimation { step = .setup }
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}

/// Full-screen dimmed spinner shown while a create/post request is in flight.
struct FMBlockingSpinner: View {
    var body: some View {
        ZStack {
            Color.black.opacity(0.45).ignoresSafeArea()
            ProgressView()
                .controlSize(.large)
                .tint(FMColor.ball500)
                .padding(24)
                .background(FMColor.ink800)
                .fmRoundedBorder(radius: 16, color: FMColor.borderSubtle)
        }
        .transition(.opacity)
    }
}
