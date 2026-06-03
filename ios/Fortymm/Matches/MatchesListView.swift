import SwiftUI

/// The Matches tab: season record header, a wins/losses filter, and the list of
/// matches (newest first). Tapping a row opens its detail. Backed by the shared
/// `MatchFlowStore` so a freshly posted result appears at the top.
struct MatchesListView: View {
    @EnvironmentObject private var store: MatchFlowStore
    @State private var filter = 0   // 0 all · 1 wins · 2 losses
    @State private var selected: FinalMatch?

    private var shown: [FinalMatch] {
        switch filter {
        case 1: return store.matches.filter(\.win)
        case 2: return store.matches.filter { !$0.win }
        default: return store.matches
        }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                recordCard
                filterBar
                listCard
            }
            .padding(.horizontal, 16)
            .padding(.top, 16)
            .padding(.bottom, 24)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
        .fullScreenCover(item: $selected) { match in
            MatchDetailView(match: match, onBack: { selected = nil }, onAgain: { selected = nil })
        }
    }

    private var recordCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("Season record")
                .padding(.bottom, 10)
            HStack(alignment: .top) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(store.record.wins)").foregroundStyle(FMColor.fg1)
                    Text("–").foregroundStyle(FMColor.ink500)
                    Text("\(store.record.losses)").foregroundStyle(FMColor.fg1)
                }
                .font(FMFont.mono(56, weight: .bold))
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("\(store.record.winRate)%")
                        .font(FMFont.mono(28, weight: .bold))
                        .foregroundStyle(FMColor.serve500)
                    Eyebrow("Win rate")
                }
            }
            HStack(spacing: 18) {
                stat("Current streak", store.record.streak, FMColor.serve500)
                stat("This season", "\(store.record.logged) logged", FMColor.fg1)
            }
            .padding(.top, 14)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: 16, color: FMColor.borderSubtle)
    }

    private func stat(_ label: String, _ value: String, _ color: Color) -> some View {
        (Text(label + " ").font(FMFont.ui(13)).foregroundStyle(FMColor.fg3)
            + Text(value).font(FMFont.mono(13, weight: .semibold)).foregroundStyle(color))
    }

    private var filterBar: some View {
        HStack(spacing: 4) {
            ForEach(Array(["All", "Wins", "Losses"].enumerated()), id: \.offset) { i, label in
                Button { filter = i } label: {
                    Text(label)
                        .font(FMFont.ui(14, weight: .semibold))
                        .foregroundStyle(filter == i ? FMColor.fg1 : FMColor.fg3)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(filter == i ? FMColor.ink600 : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: 13, color: FMColor.borderSubtle)
        .padding(.vertical, 18)
    }

    @ViewBuilder
    private var listCard: some View {
        VStack(spacing: 0) {
            if shown.isEmpty {
                Text("Nothing here yet. Go play.")
                    .font(FMFont.ui(14, weight: .medium))
                    .foregroundStyle(FMColor.fgMuted)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else {
                ForEach(Array(shown.enumerated()), id: \.element.id) { i, m in
                    MatchRow(match: m) { selected = m }
                    if i < shown.count - 1 { Divider().overlay(FMColor.ink700) }
                }
            }
        }
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: 16, color: FMColor.borderSubtle)
    }
}

private struct MatchRow: View {
    let match: FinalMatch
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 13) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill((match.win ? FMColor.serve500 : FMColor.loss).opacity(0.12))
                        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .stroke((match.win ? FMColor.serve500 : FMColor.loss).opacity(0.2), lineWidth: 1))
                        .frame(width: 42, height: 42)
                    Text(match.win ? "W" : "L")
                        .font(FMFont.ui(15, weight: .bold))
                        .foregroundStyle(match.win ? FMColor.serve500 : FMColor.loss)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("vs \(match.opponent.handle)")
                        .font(FMFont.ui(15, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                        .lineLimit(1)
                    Text("\(match.when) · \(contextLabel)")
                        .font(FMFont.ui(12.5))
                        .foregroundStyle(FMColor.fg3)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 0) {
                    HStack(spacing: 2) {
                        Text("\(match.setsWon.a)")
                        Text("–").foregroundStyle(FMColor.fgMuted)
                        Text("\(match.setsWon.b)")
                    }
                    .font(FMFont.mono(18, weight: .bold))
                    .foregroundStyle(FMColor.fg1)
                    if let delta = match.ratingDelta {
                        Text("\(delta >= 0 ? "+" : "")\(delta)")
                            .font(FMFont.mono(12, weight: .semibold))
                            .foregroundStyle(delta >= 0 ? FMColor.serve500 : FMColor.loss)
                    }
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(FMColor.ink500)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 15)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var contextLabel: String {
        if match.context.contains("Rated") { return "Club ladder" }
        return match.context == "Casual" ? "Friendly" : match.context
    }
}
