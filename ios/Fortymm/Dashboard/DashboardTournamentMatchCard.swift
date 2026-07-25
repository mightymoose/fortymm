import SwiftUI

/// The tournament panel's headline card: the one match the player is playing,
/// about to play, or just played.
///
/// The score is **games won**, not points — the number that decides a match —
/// with the per-game points beneath it as chips. A live card glows, and every
/// state announces itself in words ("Live · Table 4 · Game 4", "Match complete
/// …") as well as in colour, so the state is never carried by colour alone.
///
/// Pure view-in: every label, tone and target on it was already decided by
/// `projectTournamentPanel`. The iOS counterpart of the web's
/// `TournamentMatchCard`.
struct TournamentMatchCard: View {
    let match: TournamentMatchCardView
    /// Run one of the card's buttons — the dashboard fetches the match and
    /// presents scoring or detail, the same path the attention panel uses.
    let onAct: (TournamentMatchTarget) -> Void

    private var live: Bool { match.state == .live }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            statusRow

            TournamentOverline(text: "Games won · match score", size: 9)
                .padding(.top, FMSpace.s4)
                .padding(.bottom, 6)
            scoreRow(name: match.youName, games: match.yourGames, won: match.youWon)
            Rectangle()
                .fill(FMColor.borderSubtle)
                .frame(height: 1)
                .padding(.vertical, 6)
            scoreRow(name: match.opponentName, games: match.opponentGames, won: match.opponentWon)

            if match.state == .voided {
                Text("This match was voided — it counts for nothing and has no winner.")
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, FMSpace.s3)
            }

            // A `nil` legend means there are no chips to explain, so the whole
            // completed-games block is absent rather than an empty heading.
            if let legend = match.gamesLegend {
                TournamentGameChips(legend: legend, games: match.games)
                    .padding(.top, FMSpace.s4)
            }

            if let schedule = match.scheduleText {
                Text(schedule)
                    .font(FMFont.mono(FMFont.sm, weight: .semibold))
                    .foregroundStyle(FMColor.ball500)
                    .padding(.top, FMSpace.s4)
            }

            actions
        }
        .padding(FMSpace.s4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgCard)
        .fmRoundedBorder(
            radius: FMRadius.md,
            color: live ? FMColor.serve500.opacity(0.35) : FMColor.borderSubtle
        )
        // The live glow, the phone-sized echo of the web card's box-shadow.
        .shadow(color: live ? FMColor.serve500.opacity(0.16) : .clear, radius: 12)
    }

    // MARK: - Status

    private var statusRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: FMSpace.s2) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                statusGlyph
                Text(match.statusText)
                    .font(FMFont.mono(FMFont.xs, weight: .semibold))
                    .tracking(1.0)
                    .foregroundStyle(live ? FMColor.serve500 : FMColor.fg3)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: FMSpace.s2)
            Text(match.bestOfText)
                .font(FMFont.mono(FMFont.xs, weight: .semibold))
                .tracking(0.8)
                .foregroundStyle(FMColor.fg3)
                .padding(.horizontal, 10)
                .padding(.vertical, 3)
                .overlay(Capsule().stroke(FMColor.borderSubtle, lineWidth: 1))
                .fixedSize()
        }
    }

    /// A glyph beside the status line so "live" and "finished" are legible
    /// without reading the colour. Decorative — the words beside it carry the
    /// meaning for VoiceOver.
    @ViewBuilder
    private var statusGlyph: some View {
        switch match.state {
        case .live:
            Circle()
                .fill(FMColor.serve500)
                .frame(width: 8, height: 8)
                .shadow(color: FMColor.serve500.opacity(0.6), radius: 4)
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 1 }
        case .completed:
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(FMColor.fg3)
        case .scheduled, .voided, .unknown:
            Image(systemName: "clock")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(FMColor.fg3)
        }
    }

    // MARK: - Score

    /// One side of the games-won score. `won` crowns the row; a completed match
    /// dims the side that didn't win, while a live or voided match dims neither
    /// (there is no loser yet, and a voided match will never have one).
    private func scoreRow(name: String, games: Int, won: Bool) -> some View {
        let dimmed = match.state == .completed && !won
        return HStack(spacing: FMSpace.s2) {
            Text(name)
                .font(FMFont.ui(FMFont.md, weight: .semibold))
                .foregroundStyle(FMColor.fg1)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            if won {
                FMBadge(text: "Winner", variant: .live)
                    .fixedSize()
            }
            Text("\(games)")
                .font(FMFont.mono(40, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(won ? FMColor.serve500 : (dimmed ? FMColor.fg3 : FMColor.fg1))
                .fixedSize()
        }
    }

    // MARK: - Actions

    /// The card's buttons, in a flow layout because "Enter Game 4 result" beside
    /// "Match details" is wider than a phone's card at any sane font size — they
    /// wrap onto two lines rather than being clipped.
    @ViewBuilder
    private var actions: some View {
        if match.action != nil || match.detailsTarget != nil {
            FlowLayout(spacing: FMSpace.s2, lineSpacing: FMSpace.s2) {
                if let action = match.action {
                    FMButton(title: action.label, variant: .primary, size: .md) {
                        onAct(action.target)
                    }
                }
                if let details = match.detailsTarget {
                    FMButton(title: "Match details", variant: .outline, size: .md) {
                        onAct(details)
                    }
                }
            }
            .padding(.top, FMSpace.s4)
        }
    }
}

// MARK: - Game chips

/// The per-game points behind a match card's games-won score, as chips.
///
/// Each chip is two numerals, so each carries its own full sentence for
/// assistive tech ("Game 3: mightymoose 11, slim-manatee 9") rather than relying
/// on the legend above it having been read first.
struct TournamentGameChips: View {
    /// `mightymoose shown first · vs slim-manatee` — without it two bare numbers
    /// are ambiguous about whose is whose.
    let legend: String
    let games: [TournamentGameChipView]

    var body: some View {
        if games.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                TournamentOverline(text: "Completed games", size: 9)
                    .padding(.bottom, 4)
                Text(legend)
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.bottom, FMSpace.s2)
                FlowLayout(spacing: FMSpace.s2, lineSpacing: FMSpace.s2) {
                    ForEach(games) { game in chip(game) }
                }
            }
        }
    }

    private func chip(_ game: TournamentGameChipView) -> some View {
        HStack(spacing: 6) {
            Text(game.label)
                .font(FMFont.ui(FMFont.xs, weight: .semibold))
                .foregroundStyle(FMColor.fgMuted)
            Text(game.score)
                .font(FMFont.mono(FMFont.sm, weight: .bold))
                .monospacedDigit()
                .foregroundStyle(FMColor.fg1)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(FMColor.ink900)
        .fmRoundedBorder(radius: FMRadius.sm, color: FMColor.ink700)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(game.description)
    }
}
