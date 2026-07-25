import SwiftUI

/// The panel that tops the dashboard while the viewer is playing in a live
/// tournament: the tournament's name and venue, a tab per event they entered,
/// and inside each tab the one match to look at, where they stand, and their
/// remaining schedule.
///
/// It sits **above** the attention panel deliberately (see `DashboardView`).
/// During a tournament the match in front of you outranks every other to-do on
/// the dashboard, and a player standing at a table should not have to scroll for
/// it.
///
/// Pure view-in — every label, ordinal and target is decided by
/// `projectTournamentPanel`; this file only renders. The iOS counterpart of the
/// web's `TournamentPanel`, laid out for one narrow column instead of the web's
/// two-track grid.
///
/// The web header carries a "View group & standings" link into the tournament
/// screen. iOS has no tournament screen yet, so `view.destinationLabel` is
/// deliberately **not** rendered: a link to nowhere is worse than no link. It
/// stays on the view model, ready for the day that screen lands.
struct DashboardTournamentPanel: View {
    let view: TournamentPanelView
    /// Open the tapped match — the dashboard fetches it and presents scoring or
    /// detail through the same cover the attention panel uses.
    let onAct: (TournamentMatchTarget) -> Void

    /// Which event's tab is showing. Tab state is local to the panel, and keyed
    /// by **event id** rather than an index because the tab set can change under
    /// us when a match finishes and the dashboard refetches — an index would
    /// silently move the viewer to a different event. `nil` means "whichever is
    /// first", which is also where a viewer lands if the event they chose leaves
    /// the payload.
    @State private var activeTab: UUID?

    var body: some View {
        // `projectTournamentPanels` already drops an event-less tournament, so
        // this is belt-and-braces — but it keeps the `tabs[0]` below total.
        if view.tabs.isEmpty {
            EmptyView()
        } else {
            panel
        }
    }

    private var current: TournamentTabView {
        view.tabs.first { $0.id == activeTab } ?? view.tabs[0]
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            header
            tabStrip
            tabContent
        }
        .padding(FMSpace.s5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgPanel)
        .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            TournamentOverline(text: "Your tournament", color: FMColor.ball500)
            HStack(alignment: .firstTextBaseline, spacing: FMSpace.s3) {
                Text(view.name.uppercased())
                    .font(FMFont.display(26))
                    .tracking(1.2)
                    .foregroundStyle(FMColor.fg1)
                    .lineLimit(2)
                    .minimumScaleFactor(0.7)
                Spacer(minLength: 0)
                // Absent (not zeroed) when nothing of the viewer's is on a table
                // right now — an idle tournament must not wear a live badge.
                if let liveLabel = view.liveLabel {
                    FMBadge(text: liveLabel, variant: .live)
                        .fixedSize()
                }
            }
            Text(view.subtitle)
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg3)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Tabs

    /// One tab per event the viewer entered. Rendered even for a single event —
    /// it is the only place the event's *name* appears, and it carries the live
    /// marker. Scrolls horizontally rather than compressing, so a three-event
    /// entrant's tabs stay readable on a phone.
    private var tabStrip: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(view.tabs) { tab in
                    Button { activeTab = tab.id } label: { tabLabel(tab) }
                        .buttonStyle(.plain)
                }
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(FMColor.borderSubtle).frame(height: 1)
        }
    }

    private func tabLabel(_ tab: TournamentTabView) -> some View {
        let selected = tab.id == current.id
        return VStack(spacing: 6) {
            HStack(spacing: 6) {
                Text(tab.name)
                    .font(FMFont.ui(FMFont.sm, weight: .semibold))
                    .foregroundStyle(selected ? FMColor.fg1 : FMColor.fg3)
                    .lineLimit(1)
                if tab.live {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(FMColor.serve500)
                            .frame(width: 6, height: 6)
                            .shadow(color: FMColor.serve500.opacity(0.6), radius: 4)
                        Text("Live")
                            .font(FMFont.ui(FMFont.xs, weight: .bold))
                            .foregroundStyle(FMColor.serve500)
                    }
                }
            }
            .padding(.horizontal, FMSpace.s3)
            .padding(.vertical, FMSpace.s2)
            // The selected tab's underline sits ON the strip's hairline, so the
            // two never double up.
            Rectangle()
                .fill(selected ? FMColor.ball500 : Color.clear)
                .frame(height: 2)
        }
    }

    // MARK: - Tab content

    @ViewBuilder
    private var tabContent: some View {
        VStack(alignment: .leading, spacing: FMSpace.s4) {
            if let match = current.match {
                TournamentMatchCard(match: match, onAct: onAct)
            } else {
                noMatchCard
            }
            TournamentStatsStrip(stats: current.stats)
            TournamentPathList(
                heading: current.pathHeading,
                subheading: current.pathSubheading,
                rows: current.path
            )
        }
    }

    /// An event whose draw hasn't been made has no match to show — and says so,
    /// rather than showing an empty card the viewer reads as a bug.
    private var noMatchCard: some View {
        Text("The draw for this event hasn't been made yet. Your matches will appear here once it is.")
            .font(FMFont.ui(FMFont.sm))
            .foregroundStyle(FMColor.fg3)
            .fixedSize(horizontal: false, vertical: true)
            .padding(FMSpace.s4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(FMColor.bgCard)
            .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
    }
}

// MARK: - Stats strip

/// The three-tile strip under a tournament event's match card: the viewer's
/// win–loss record, where they stand in their pool, and what stage the event is
/// at.
///
/// The middle tile is the one that can be absent — an event whose draw has not
/// been cut has no standings to stand in — and it renders an em-dash rather than
/// disappearing, so the strip keeps its three-column rhythm between loads. It is
/// never a `0th`.
struct TournamentStatsStrip: View {
    let stats: TournamentStatsView

    var body: some View {
        HStack(alignment: .top, spacing: FMSpace.s3) {
            tile(label: "Match record") {
                (Text("\(stats.wins)").foregroundStyle(FMColor.fg1)
                    + Text("–").foregroundStyle(FMColor.fg3)
                    + Text("\(stats.losses)").foregroundStyle(FMColor.fg1))
                    .font(FMFont.mono(20, weight: .bold))
                    .monospacedDigit()
            }
            divider
            tile(label: stats.positionLabel) { position }
            divider
            tile(label: "Stage") {
                Text(stats.stageValue)
                    .font(FMFont.ui(FMFont.sm, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, FMSpace.s4)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderSubtle)
    }

    @ViewBuilder
    private var position: some View {
        if let value = stats.positionValue {
            (Text(value)
                .font(FMFont.mono(18, weight: .bold))
                .foregroundStyle(FMColor.fg1)
                + Text(" \(stats.positionSuffix ?? "")")
                .font(FMFont.ui(FMFont.sm))
                .foregroundStyle(FMColor.fg3))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        } else {
            Text("—")
                .font(FMFont.ui(FMFont.md))
                .foregroundStyle(FMColor.fg3)
        }
    }

    private var divider: some View {
        Rectangle()
            .fill(FMColor.borderSubtle)
            .frame(width: 1, height: 32)
    }

    private func tile<C: View>(label: String, @ViewBuilder value: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            // A third of a phone's width is narrower than "GROUP POSITION" at any
            // tracking, so the label WRAPS rather than truncating — an ellipsised
            // "GROUP POSI…" names nothing.
            TournamentOverline(text: label, size: 9)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            value()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - Path list

/// The viewer's own schedule within one tournament event, in draw order.
///
/// Renders nothing at all when there are no rows: an event whose draw has not
/// been cut has no schedule yet, and a heading over an empty list would read as
/// "you have no matches" rather than "the draw is not made".
struct TournamentPathList: View {
    /// `Your matches` — what this event calls the viewer's own run through it.
    let heading: String
    /// `Pool A · 4 players`, or `nil` for an un-pooled draw.
    let subheading: String?
    let rows: [TournamentPathRowView]

    var body: some View {
        if rows.isEmpty {
            EmptyView()
        } else {
            VStack(alignment: .leading, spacing: 0) {
                TournamentOverline(text: heading, size: 9)
                    .padding(.bottom, subheading == nil ? FMSpace.s2 : 3)
                if let subheading {
                    Text(subheading)
                        .font(FMFont.mono(FMFont.xs))
                        .foregroundStyle(FMColor.fg3)
                        .padding(.bottom, FMSpace.s2)
                }
                VStack(spacing: FMSpace.s2) {
                    ForEach(rows) { row in TournamentPathRow(row: row) }
                }
            }
        }
    }
}

/// One line of a tournament event's schedule: its ordinal, the opponent, and the
/// result-or-time on the right.
///
/// Every state carries a glyph as well as its colour — a check for a played
/// match, a filled dot for a live one, a hollow one for a match still to come,
/// a "no entry" for a voided one — so the row is never distinguished by colour
/// alone. An unmaterialised fixture prints the projection's `TBD` opponent, not
/// a blank.
private struct TournamentPathRow: View {
    let row: TournamentPathRowView

    var body: some View {
        HStack(spacing: FMSpace.s2) {
            glyph.frame(width: 14)
            Text(row.label)
                .font(FMFont.mono(FMFont.xs))
                .foregroundStyle(FMColor.fgMuted)
                .frame(width: 24, alignment: .leading)
            Text(row.opponentName)
                .font(FMFont.ui(FMFont.sm, weight: .medium))
                .foregroundStyle(FMColor.fg1)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Text(row.detail)
                .font(FMFont.mono(FMFont.xs, weight: detailWeight))
                .foregroundStyle(detailColor)
                .lineLimit(1)
                .layoutPriority(1)
        }
        .padding(.horizontal, FMSpace.s3)
        .padding(.vertical, 10)
        .background(FMColor.bgCard)
        .fmRoundedBorder(
            radius: FMRadius.sm,
            color: row.state == .live ? FMColor.serve500.opacity(0.4) : FMColor.borderSubtle
        )
    }

    @ViewBuilder
    private var glyph: some View {
        switch row.state {
        case .voided:
            // Struck through, not checked: a voided match was not played to a
            // result, so it must not wear the glyph that means "decided".
            Image(systemName: "nosign")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(FMColor.fg3)
        case .completed:
            Image(systemName: "checkmark")
                .font(.system(size: 11, weight: .bold))
                .foregroundStyle(row.youWon == true ? FMColor.serve500 : FMColor.fg3)
        case .live:
            Circle()
                .fill(FMColor.serve500)
                .frame(width: 9, height: 9)
                .shadow(color: FMColor.serve500.opacity(0.6), radius: 4)
        case .upcoming, .unknown:
            Circle()
                .stroke(FMColor.ink500, lineWidth: 1.5)
                .frame(width: 9, height: 9)
        }
    }

    /// A loss keeps the row readable without shouting: the detail text already
    /// says "Lost 0–2", so the tone only needs to stop claiming a win. A row with
    /// no outcome yet (`youWon == nil`) claims neither.
    private var detailColor: Color {
        if row.youWon == false { return FMColor.loss }
        if row.state == .upcoming || row.state == .voided { return FMColor.fg3 }
        return FMColor.serve500
    }

    private var detailWeight: Font.Weight {
        row.state == .upcoming || row.state == .voided ? .regular : .bold
    }
}

// MARK: - Shared bits

/// The panel's small uppercase label. A sibling of `DashOverline` that takes a
/// colour, which the panel needs for its accented "YOUR TOURNAMENT" eyebrow.
struct TournamentOverline: View {
    let text: String
    var size: CGFloat = FMFont.xs
    var color: Color = FMColor.fgMuted

    var body: some View {
        Text(text.uppercased())
            .font(FMFont.mono(size, weight: .medium))
            .tracking(1.4)
            .foregroundStyle(color)
    }
}

// MARK: - Previews

#Preview("Live tournament") {
    ScrollView {
        DashboardTournamentPanel(view: previewPanel, onAct: { _ in })
            .padding(FMSpace.s5)
    }
    .background(FMColor.bgApp)
    .preferredColorScheme(.dark)
}

private let previewPanel = TournamentPanelView(
    id: UUID(),
    name: "Riverside Summer Open",
    subtitle: "Riverside TTC · Jul 24",
    liveLabel: "1 live now",
    destinationLabel: "View group & standings",
    tabs: [
        TournamentTabView(
            id: UUID(),
            name: "Men's Singles",
            live: true,
            stats: TournamentStatsView(
                wins: 2,
                losses: 1,
                positionLabel: "Group position",
                positionValue: "2nd",
                positionSuffix: "of 4",
                stageValue: "Group play"
            ),
            match: TournamentMatchCardView(
                state: .live,
                statusText: "Live · Table 4 · Game 4",
                bestOfText: "Best of 5",
                youName: "mightymoose",
                opponentName: "slim-manatee",
                yourGames: 2,
                opponentGames: 1,
                youWon: false,
                opponentWon: false,
                gamesLegend: "mightymoose shown first · vs slim-manatee",
                games: [
                    TournamentGameChipView(number: 1, label: "Game 1", score: "11–9", description: ""),
                    TournamentGameChipView(number: 2, label: "Game 2", score: "8–11", description: ""),
                    TournamentGameChipView(number: 3, label: "Game 3", score: "11–7", description: ""),
                ],
                action: TournamentMatchAction(
                    label: "Enter Game 4 result",
                    target: .scoring(matchId: UUID(), gameNumber: 4)
                ),
                detailsTarget: .detail(matchId: UUID()),
                scheduleText: nil
            ),
            pathHeading: "Your matches",
            path: [
                TournamentPathRowView(id: "1", label: "M1", opponentName: "tess.k", state: .completed, detail: "Won 3–1", youWon: true),
                TournamentPathRowView(id: "2", label: "M2", opponentName: "raj-p", state: .completed, detail: "Lost 1–3", youWon: false),
                TournamentPathRowView(id: "3", label: "M3", opponentName: "slim-manatee", state: .live, detail: "In progress", youWon: nil),
                TournamentPathRowView(id: "4", label: "M4", opponentName: "TBD", state: .upcoming, detail: "6:00 PM CDT · Table 3", youWon: nil),
            ],
            pathSubheading: "Pool A · 4 players"
        ),
    ]
)
