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
    /// When set, the flow skips setup and opens straight into scoring an
    /// existing live match (the "resume" entry point from the detail/list/
    /// dashboard surfaces). Nil ⇒ the normal new-match flow.
    var resume: ResumeScoring?
    /// Close the flow. `toMatches` = land on the Matches tab (vs. just dismiss).
    var onClose: (_ toMatches: Bool) -> Void

    /// Loaded session, so the scoring scoreboard can label your side with your
    /// real username instead of a generic "You" (issue #451). Propagated into the
    /// full-screen cover from `RootView`, which injects it.
    @EnvironmentObject private var session: SessionStore

    init(
        service: MatchService = .shared,
        resume: ResumeScoring? = nil,
        onClose: @escaping (_ toMatches: Bool) -> Void
    ) {
        self.service = service
        self.resume = resume
        self.onClose = onClose
        _step = State(initialValue: resume == nil ? .setup : .score)
        _matchId = State(initialValue: resume?.matchId)
        _opponent = State(initialValue: resume?.config.opponent)
        _bestOf = State(initialValue: resume?.config.bestOf ?? 5)
        _rated = State(initialValue: resume?.config.rated ?? false)
    }

    private enum Step { case setup, score, detail }
    @State private var step: Step
    @State private var opponent: MatchPlayer?
    @State private var bestOf: Int
    @State private var rated: Bool

    /// Server match id, captured when the match is created on "Start match",
    /// or supplied up front when resuming an existing match.
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
                    // Cancel just dismisses the cover, leaving `selection` on the
                    // tab the flow was launched from (e.g. Home) — not Matches.
                    onCancel: { onClose(false) }
                )
                .transition(.opacity)
            case .score:
                ScoreEntryView(
                    config: config,
                    // Carried for the (future) per-game write path; unused by the
                    // board today. `matchId` is set before this step in both
                    // paths (start() on new matches, the resume seed otherwise) —
                    // same non-nil guarantee `post()` leans on with `guard let`.
                    matchId: matchId,
                    yourSideNumber: resume?.yourSideNumber ?? 1,
                    // Same service the flow posts results through, so per-game
                    // scratchpad writes and the final post share one client.
                    service: service,
                    // ScoreEntryView now holds `[ScoredGame]` directly, so the
                    // resume games ride in with their sync state intact — no
                    // down-adapter. The board still reads only `.points`.
                    initialGames: resume?.games ?? [],
                    onPost: post,
                    correction: resume?.isCorrection ?? false,
                    meName: session.username,
                    // Resuming has no setup step to fall back to — exiting closes
                    // the flow (back to wherever it was launched from).
                    onExit: {
                        if resume == nil { withAnimation { step = .setup } }
                        else { onClose(false) }
                    }
                )
                .transition(.move(edge: .trailing).combined(with: .opacity))
            case .detail:
                if let final {
                    MatchDetailView(
                        initial: final,
                        onBack: { onClose(true) }
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
                withAnimation { step = .score }
            } catch {
                errorMessage = error.fmMessage
            }
            busy = false
        }
    }

    /// Post the completed games for the match and show the server's result.
    /// A correction board (resume carries `supersedesResultId`) posts as a
    /// counter-proposal superseding the standing result; the server 409s if
    /// that proposal has since moved on (accepted or re-corrected).
    private func post(_ games: [Game]) {
        guard let matchId, !busy else { return }
        busy = true
        Task {
            do {
                final = try await service.postResult(
                    matchId: matchId, games: games,
                    yourSideNumber: resume?.yourSideNumber ?? 1,
                    supersedes: resume?.supersedesResultId
                )
                withAnimation { step = .detail }
            } catch APIError.http(409, _) where resume?.isCorrection == true {
                errorMessage = "This result changed while you were editing — reopen the match to review the latest score."
            } catch {
                errorMessage = error.fmMessage
            }
            busy = false
        }
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
