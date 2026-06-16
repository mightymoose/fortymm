import SwiftUI

// MARK: - View model

/// Where an attention row's button takes the user. Mirrors the web view-model's
/// `routeOf`: a `score` row with a known game deep-links into scoring; every
/// other row (review/dispute, or a decided-but-unposted board) goes to match
/// detail, which holds the confirm/dispute/post-result actions.
enum AttentionTarget: Equatable {
    case scoring(gameNumber: Int)
    case detail
}

/// One projected row of the "Needs your attention" panel — ready to render and
/// route, with all ranking/labels/targets decided by `projectAttentionPanel`.
struct AttentionRowView: Identifiable {
    let matchId: UUID
    /// Avatar/headline seed — nil renders the "No opponent" placeholder.
    let opponentUsername: String?
    /// Row headline, e.g. `vs nguyen.t` or `No opponent`.
    let headline: String
    /// Button copy: `Resolve dispute` | `Review result` | `Enter score`.
    let actionLabel: String
    /// Whether this row takes the primary (filled) button — true for every row
    /// in the highest-priority bucket currently visible.
    let primary: Bool
    let target: AttentionTarget

    var id: UUID { matchId }
}

/// The projected panel: the (≤3) rows to render plus the footer counts.
struct AttentionPanelView {
    let rows: [AttentionRowView]
    /// Actionable items beyond the visible 3 — footer "N more need attention".
    let overflowCount: Int
    /// Matches waiting on someone else — footer "N waiting on others".
    let waitingCount: Int
}

/// Whether the panel has nothing to show — no actionable rows, no overflow, and
/// nobody waiting on others. The panel hides entirely in this case rather than
/// rendering a standalone "all caught up" card (a calm empty state still shows
/// when rows are empty but the footer has a waiting/overflow count to surface).
/// Mirrors the web view-model's `isAttentionPanelEmpty`.
func isAttentionPanelEmpty(_ view: AttentionPanelView) -> Bool {
    view.rows.isEmpty && view.overflowCount == 0 && view.waitingCount == 0
}

/// The panel never grows unbounded — show the top 3 rows, roll the rest into
/// the footer (mirrors the web's `ATTENTION_VISIBLE_LIMIT`).
private let attentionVisibleLimit = 3

private let noOpponentLabel = "No opponent"

// A row's attention "bucket" — the unit the primary-button rule operates on
// (score rows split rated vs unrated; review/dispute are each their own
// bucket). The priority *ordering* is the server's job: items arrive
// pre-sorted, so the first visible row is the highest-priority bucket present,
// and every row sharing its bucket takes the primary button.
private func bucketKey(_ item: DashboardAttentionItem) -> String {
    item.kind == .score ? "score-\(item.affectsRating)" : item.kind.rawValue
}

private func actionLabel(_ kind: AttentionKind) -> String {
    switch kind {
    case .dispute: return "Resolve dispute"
    case .review: return "Review result"
    case .score: return "Enter score"
    case .unknown: return "View match"
    }
}

private func target(_ item: DashboardAttentionItem) -> AttentionTarget {
    if item.kind == .score, let game = item.currentGameNumber {
        return .scoring(gameNumber: game)
    }
    return .detail
}

/// Project the BFF's pre-ranked attention items into the panel's view model:
/// cap visible rows at 3, compute the footer counts, and mark the
/// highest-priority *visible* bucket as primary (so a `Review result` beneath a
/// `Resolve dispute` renders secondary). Items arrive already sorted by the
/// server, so their order is preserved as-is. Mirrors the web's
/// `projectAttentionPanelView`.
func projectAttentionPanel(
    items: [DashboardAttentionItem],
    waitingCount: Int
) -> AttentionPanelView {
    let visible = Array(items.prefix(attentionVisibleLimit))
    let topBucket = visible.first.map(bucketKey) ?? ""
    return AttentionPanelView(
        rows: visible.map { item in
            AttentionRowView(
                matchId: item.matchId,
                opponentUsername: item.opponentUsername,
                headline: item.opponentUsername.map { "vs \($0)" } ?? noOpponentLabel,
                actionLabel: actionLabel(item.kind),
                primary: bucketKey(item) == topBucket,
                target: target(item)
            )
        },
        overflowCount: max(0, items.count - attentionVisibleLimit),
        waitingCount: waitingCount
    )
}

// MARK: - View

/// The dashboard's "Needs your attention" triage panel: up to three
/// priority-ordered, action-only rows (avatar · `vs @opponent` · one button)
/// plus a footer summarizing overflow + waiting counts and a "View all" link.
/// Pure view-in — all ranking/labels/targets are decided by
/// `projectAttentionPanel`. Buttons only route; they never finalize a result.
/// Hides entirely when there's nothing to surface; falls back to a calm empty
/// state when there are no rows but the footer still has a waiting/overflow
/// count to show. Mirrors the web dashboard's `AttentionPanel`.
struct DashboardAttentionPanel: View {
    let view: AttentionPanelView
    /// Run the row's action — fetch the match and open scoring or detail.
    let onAct: (AttentionRowView) -> Void
    /// Footer "View all" — send the user to the Matches tab.
    let onViewAll: () -> Void

    var body: some View {
        if isAttentionPanelEmpty(view) {
            EmptyView()
        } else {
            panel
        }
    }

    private var panel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Needs your attention")
                .font(FMFont.ui(FMFont.md, weight: .semibold))
                .foregroundStyle(FMColor.fg1)
                .padding(.horizontal, FMSpace.s4)
                .padding(.top, FMSpace.s4)
                .padding(.bottom, FMSpace.s3)

            Rectangle().fill(FMColor.ink700).frame(height: 1)

            if view.rows.isEmpty {
                Text("You're all caught up.")
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fg3)
                    .padding(FMSpace.s4)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(view.rows.enumerated()), id: \.element.id) { i, row in
                    if i > 0 { Rectangle().fill(FMColor.ink700).frame(height: 1) }
                    AttentionRow(row: row) { onAct(row) }
                }
            }

            Rectangle().fill(FMColor.ink700).frame(height: 1)
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.bgCard)
        .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
    }

    private var footer: some View {
        HStack(spacing: FMSpace.s2) {
            ForEach(footerParts, id: \.self) { part in
                Text("\(part) ·")
                    .font(FMFont.ui(FMFont.sm))
                    .foregroundStyle(FMColor.fgMuted)
            }
            Button(action: onViewAll) {
                Text("View all")
                    .font(FMFont.ui(FMFont.sm, weight: .medium))
                    .foregroundStyle(FMColor.fg3)
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, FMSpace.s4)
        .padding(.vertical, FMSpace.s3)
    }

    private var footerParts: [String] {
        var parts: [String] = []
        if view.overflowCount > 0 {
            let verb = view.overflowCount == 1 ? "needs" : "need"
            parts.append("\(view.overflowCount) more \(verb) attention")
        }
        if view.waitingCount > 0 {
            parts.append("\(view.waitingCount) waiting on others")
        }
        return parts
    }
}

/// One actionable row: avatar · headline · the single routing button.
private struct AttentionRow: View {
    let row: AttentionRowView
    let onAct: () -> Void

    var body: some View {
        HStack(spacing: FMSpace.s3) {
            FMAvatar(
                initials: (row.opponentUsername ?? "?").fmInitials,
                size: 40,
                color: avatarColor,
                foreground: FMColor.fg1
            )
            Text(row.headline)
                .font(FMFont.ui(FMFont.base, weight: .semibold))
                .foregroundStyle(row.opponentUsername == nil ? FMColor.fgMuted : FMColor.fg1)
                .italic(row.opponentUsername == nil)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            FMButton(
                title: row.actionLabel,
                variant: row.primary ? .primary : .outline,
                size: .sm,
                action: onAct
            )
        }
        .padding(.horizontal, FMSpace.s4)
        .padding(.vertical, FMSpace.s3)
    }

    private var avatarColor: Color {
        guard let opponent = row.opponentUsername else { return FMColor.ink600 }
        return MatchPlayer.avatarColor(for: opponent).color
    }
}
