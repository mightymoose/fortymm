import SwiftUI

/// The Matches tab: season-record header, a wins/losses filter, and the list of
/// the current user's matches (newest first). Tapping a row opens its detail.
/// Backed by the API (`GET /v1/matches` for the list, the player profile for the
/// record); pull-to-refresh and re-entering the tab re-fetch.
struct MatchesListView: View {
    var service: MatchService = .shared

    @State private var filter = 0   // 0 all · 1 wins · 2 losses
    @State private var selected: FinalMatch?

    @State private var matches: [FinalMatch] = []
    @State private var record: MyRecord?
    @State private var loading = true
    @State private var inFlight = false
    @State private var errorMessage: String?

    /// Wins/Losses filter only over *decided* matches; pending ones show only
    /// under "All".
    private var shown: [FinalMatch] {
        switch filter {
        case 1: return matches.filter { $0.decided && $0.win }
        case 2: return matches.filter { $0.decided && !$0.win }
        default: return matches
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
            // Top inset for the shell's frosted bar is reserved by `.fmTopBar`.
            .padding(.bottom, 24)
        }
        .background(FMColor.bgApp.ignoresSafeArea())
        .refreshable { await load() }
        // onAppear (not task) so returning to the tab after posting a match
        // re-fetches and surfaces it at the top.
        .onAppear { Task { await load() } }
        .fullScreenCover(item: $selected) { match in
            MatchDetailView(initial: match, onBack: { selected = nil }, onAgain: { selected = nil })
        }
    }

    /// Fetch the match list and the season record together. Shows a spinner
    /// only on the first load; refreshes keep the existing content in place.
    private func load() async {
        guard !inFlight else { return }
        inFlight = true
        defer { inFlight = false }
        if matches.isEmpty { loading = true }
        do {
            // Independent calls — run them concurrently.
            async let list = service.listMatches()
            async let rec = service.myRecord()
            matches = try await list
            record = try await rec
            errorMessage = nil
        } catch {
            errorMessage = error.fmMessage
        }
        loading = false
    }

    private var recordCard: some View {
        VStack(alignment: .leading, spacing: 0) {
            Eyebrow("Season record")
                .padding(.bottom, 10)
            HStack(alignment: .top) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text("\(record?.wins ?? 0)").foregroundStyle(FMColor.fg1)
                    Text("–").foregroundStyle(FMColor.ink500)
                    Text("\(record?.losses ?? 0)").foregroundStyle(FMColor.fg1)
                }
                .font(FMFont.mono(56, weight: .bold))
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    Text("\(record?.winRate ?? 0)%")
                        .font(FMFont.mono(28, weight: .bold))
                        .foregroundStyle(FMColor.serve500)
                    Eyebrow("Win rate")
                }
            }
            HStack(spacing: 18) {
                stat("Current streak", record?.streak ?? "—", FMColor.serve500)
                stat("This season", "\(record?.total ?? 0) logged", FMColor.fg1)
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
            if loading {
                ProgressView()
                    .controlSize(.regular)
                    .tint(FMColor.ball500)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
            } else if let errorMessage {
                listNote(errorMessage)
            } else if shown.isEmpty {
                listNote(matches.isEmpty ? "Nothing here yet. Go play." : "No matches in this filter.")
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

    private func listNote(_ text: String) -> some View {
        Text(text)
            .font(FMFont.ui(14, weight: .medium))
            .foregroundStyle(FMColor.fgMuted)
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 40)
            .padding(.horizontal, 16)
    }
}

private struct MatchRow: View {
    let match: FinalMatch
    let onOpen: () -> Void

    /// Outcome tint: green win / red loss once decided, amber while pending.
    private var tint: Color {
        guard match.decided else { return FMColor.warn }
        return match.win ? FMColor.serve500 : FMColor.loss
    }
    /// Single-glyph badge: W / L when decided, a dot while awaiting confirmation.
    private var badge: String {
        guard match.decided else { return "•" }
        return match.win ? "W" : "L"
    }

    var body: some View {
        Button(action: onOpen) {
            HStack(spacing: 13) {
                ZStack {
                    RoundedRectangle(cornerRadius: 11, style: .continuous)
                        .fill(tint.opacity(0.12))
                        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .stroke(tint.opacity(0.2), lineWidth: 1))
                        .frame(width: 42, height: 42)
                    Text(badge)
                        .font(FMFont.ui(15, weight: .bold))
                        .foregroundStyle(tint)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text("vs \(match.opponent.handle)")
                        .font(FMFont.ui(15, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                        .lineLimit(1)
                    Text("\(match.when) · \(subtitle)")
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

    /// Pending matches show their status; decided ones show the format label.
    private var subtitle: String {
        if !match.decided { return match.statusLabel }
        if match.context.contains("Rated") { return "Club ladder" }
        return match.context == "Casual" ? "Friendly" : match.context
    }
}
