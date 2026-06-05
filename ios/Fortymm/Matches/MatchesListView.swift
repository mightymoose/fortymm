import SwiftUI

/// The Matches tab: a player search, lifecycle status tabs (All / Live / Up
/// next / Final, mirroring the web `/matches` filters), and the global match
/// feed (newest first) with each row showing both participants. Tapping a row
/// opens its detail. All filtering is server-side via `GET /v1/matches`;
/// pull-to-refresh and re-entering the tab re-fetch.
struct MatchesListView: View {
    var service: MatchService = .shared

    @State private var statusTab: StatusTab = .all
    @State private var query = ""
    @State private var selected: FinalMatch?

    @State private var matches: [FinalMatch] = []
    @State private var statusCounts: [String: Int] = [:]
    @State private var loading = true
    @State private var errorMessage: String?
    /// Coalesces overlapping fetches (tab switch racing a search) — each reload
    /// cancels the previous so the latest filter always wins.
    @State private var loadTask: Task<Void, Never>?
    /// Debounce handle for the search field so each keystroke doesn't fire a
    /// request.
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
                searchField
                statusTabs
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
        .onAppear { reload() }
        .onChange(of: query) { _, _ in
            searchTask?.cancel()
            searchTask = Task {
                try? await Task.sleep(for: .milliseconds(350))
                if !Task.isCancelled { reload() }
            }
        }
        .fullScreenCover(item: $selected) { match in
            MatchDetailView(initial: match, onBack: { selected = nil })
        }
    }

    private func reload() {
        loadTask?.cancel()
        loadTask = Task { await load() }
    }

    /// Fetch the match list for the active status tab + search. Shows a spinner
    /// only on the first load; refreshes keep the existing content in place. A
    /// cancelled (superseded) fetch drops its result rather than overwriting a
    /// newer one.
    private func load() async {
        if matches.isEmpty { loading = true }
        do {
            let page = try await service.listMatches(status: statusTab.apiStatus, query: query)
            if Task.isCancelled { return }
            matches = page.items
            statusCounts = page.statusCounts
            errorMessage = nil
        } catch {
            if Task.isCancelled { return }
            errorMessage = error.fmMessage
        }
        loading = false
    }

    private func count(for tab: StatusTab) -> Int {
        guard let key = tab.countKey else { return statusCounts.values.reduce(0, +) }
        return statusCounts[key] ?? 0
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(FMColor.fg3)
            TextField("", text: $query, prompt: Text("Search players").foregroundStyle(FMColor.fgMuted))
                .font(FMFont.ui(15, weight: .medium))
                .foregroundStyle(FMColor.fg1)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(FMColor.fgMuted)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderDefault)
        .padding(.top, 18)
        .padding(.bottom, 12)
    }

    private var statusTabs: some View {
        HStack(spacing: 4) {
            ForEach(StatusTab.allCases) { tab in
                let active = tab == statusTab
                Button {
                    guard tab != statusTab else { return }
                    statusTab = tab
                    reload()
                } label: {
                    HStack(spacing: 5) {
                        Text(tab.label).font(FMFont.ui(13, weight: .semibold))
                        Text("\(count(for: tab))")
                            .font(FMFont.mono(12, weight: .semibold))
                            .foregroundStyle(active ? FMColor.fg3 : FMColor.fgMuted)
                    }
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                    .foregroundStyle(active ? FMColor.fg1 : FMColor.fg3)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 10)
                    .background(active ? FMColor.ink600 : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 9, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(5)
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: 13, color: FMColor.borderSubtle)
        .padding(.bottom, 18)
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
            } else if matches.isEmpty {
                listNote(emptyMessage)
            } else {
                ForEach(Array(matches.enumerated()), id: \.element.id) { i, m in
                    MatchRow(match: m) { selected = m }
                    if i < matches.count - 1 { Divider().overlay(FMColor.ink700) }
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

    private var emptyMessage: String {
        let trimmed = query.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty { return "No matches for “\(trimmed)”." }
        if statusTab != .all { return "No \(statusTab.label.lowercased()) matches." }
        return "Nothing here yet. Go play."
    }
}

/// Lifecycle filter tabs, mirroring the web `/matches` status tabs. The
/// `apiStatus` is sent as the `status` query param (nil = no filter); the
/// `countKey` indexes the server's `status_counts` for the tab badge.
private enum StatusTab: CaseIterable, Identifiable {
    case all, live, upNext, final

    var id: Self { self }

    var label: String {
        switch self {
        case .all: return "All"
        case .live: return "Live"
        case .upNext: return "Up next"
        case .final: return "Final"
        }
    }

    var apiStatus: APIMatchStatus? {
        switch self {
        case .all: return nil
        case .live: return .inProgress
        case .upNext: return .pending
        case .final: return .completed
        }
    }

    /// `status_counts` key for this tab's badge — derived from `apiStatus` so the
    /// filter value and the count lookup can't drift apart. Nil for "All", which
    /// sums every status instead.
    var countKey: String? { apiStatus?.rawValue }
}

private struct MatchRow: View {
    let match: FinalMatch
    let onOpen: () -> Void

    /// How this row reads to the viewer: still in flight, one the viewer only
    /// spectated, or their own decided win/loss. `tint` and `badge` are both pure
    /// functions of this, so the pending/spectator/own classification lives once.
    private enum Outcome { case pending, spectated, won, lost }
    private var outcome: Outcome {
        guard match.decided else { return .pending }
        guard match.viewerIsParticipant else { return .spectated }
        return match.win ? .won : .lost
    }

    /// Outcome tint: amber while pending, neutral for a spectated match, the
    /// viewer's own win/loss in green/red.
    private var tint: Color {
        switch outcome {
        case .pending: return FMColor.warn
        case .spectated: return FMColor.fg3
        case .won: return FMColor.serve500
        case .lost: return FMColor.loss
        }
    }
    /// Single-glyph badge: a dot while awaiting confirmation, a neutral check for
    /// a spectated decided match, W / L for the viewer's own decided matches.
    private var badge: String {
        switch outcome {
        case .pending: return "•"
        case .spectated: return "✓"
        case .won: return "W"
        case .lost: return "L"
        }
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
                    // Both participants, side-1-first — this list is a global feed,
                    // so the viewer often isn't one of them.
                    (Text(match.sideA.handle).foregroundStyle(FMColor.fg1)
                        + Text(" vs ").foregroundStyle(FMColor.fg3)
                        + Text(match.sideB.handle).foregroundStyle(FMColor.fg1))
                        .font(FMFont.ui(15, weight: .semibold))
                        .lineLimit(1)
                    Text("\(match.when) · \(subtitle)")
                        .font(FMFont.ui(12.5))
                        .foregroundStyle(FMColor.fg3)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                VStack(alignment: .trailing, spacing: 0) {
                    HStack(spacing: 2) {
                        Text("\(match.sideAGames)")
                        Text("–").foregroundStyle(FMColor.fgMuted)
                        Text("\(match.sideBGames)")
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
