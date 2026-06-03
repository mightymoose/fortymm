import SwiftUI

/// Screen 1 — New match setup: opponent (recent grid or search), match length,
/// rated toggle. Single screen; only the search results list scrolls.
struct NewMatchView: View {
    @Binding var opponent: MatchPlayer?
    @Binding var bestOf: Int
    @Binding var rated: Bool
    var onStart: () -> Void
    var onCancel: () -> Void

    @State private var searching = false
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var solo: Bool { opponent == nil }
    private var gamesToWin: Int { MatchRules.gamesToWin(bestOf: bestOf) }

    private static let lengths: [(n: Int, label: String)] = [
        (1, "Single"), (3, "Short"), (5, "Std"), (7, "Long"),
    ]

    var body: some View {
        VStack(spacing: 0) {
            content
            footer
        }
        .background(FMColor.ink950.ignoresSafeArea())
        // Keep the solo ⇒ unrated invariant.
        .onChange(of: solo) { _, isSolo in if isSolo { rated = false } }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Spacer()
                Button(action: onCancel) {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(FMColor.fg3)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 14)
            .padding(.top, 8)

            DisplayTitle("NEW MATCH")
                .padding(.horizontal, 20)
                .padding(.bottom, 18)

            opponentSection
            lengthSection
            ratedSection

            Spacer(minLength: 0)
        }
    }

    // MARK: Opponent

    private var opponentSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Opponent")
                    .font(FMFont.ui(16, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                Spacer()
                Text("OPTIONAL · SOLO IF BLANK")
                    .font(FMFont.ui(10, weight: .medium))
                    .tracking(1.0)
                    .foregroundStyle(FMColor.fgMuted)
            }

            if searching {
                searchField
                searchResults
            } else {
                recentGrid
            }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 20)
    }

    private var recentGrid: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack {
                Eyebrow("Recent opponents")
                Spacer()
                Button { searching = true; searchFocused = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .semibold))
                        Text("Search all").font(FMFont.ui(12, weight: .semibold))
                    }
                    .foregroundStyle(FMColor.ball500)
                }
                .buttonStyle(.plain)
            }
            LazyVGrid(columns: [GridItem(.flexible(), spacing: 9), GridItem(.flexible(), spacing: 9)], spacing: 9) {
                ForEach(MatchSeed.recent) { p in
                    OpponentCard(player: p, selected: opponent == p, showRating: false) { toggle(p) }
                }
            }
        }
    }

    private var searchField: some View {
        HStack(spacing: 9) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(FMColor.fg3)
            TextField("", text: $query, prompt: Text("Search all players").foregroundStyle(FMColor.fgMuted))
                .font(FMFont.ui(15, weight: .medium))
                .foregroundStyle(FMColor.fg1)
                .focused($searchFocused)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark").font(.system(size: 14, weight: .medium)).foregroundStyle(FMColor.fgMuted)
                }
                .buttonStyle(.plain)
            }
            Button { closeSearch() } label: {
                Text("Cancel").font(FMFont.ui(12, weight: .semibold)).foregroundStyle(FMColor.fg3)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
        .background(FMColor.ink800)
        .fmRoundedBorder(radius: FMRadius.md, color: FMColor.borderDefault)
    }

    private var searchResults: some View {
        let results = MatchSeed.allPlayers.filter {
            $0.handle.lowercased().contains(query.trimmingCharacters(in: .whitespaces).lowercased())
        }
        return ScrollView {
            VStack(spacing: 8) {
                if results.isEmpty {
                    Text("No players match “\(query)”.")
                        .font(FMFont.ui(13, weight: .medium))
                        .foregroundStyle(FMColor.fgMuted)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 30)
                } else {
                    ForEach(results) { p in
                        OpponentCard(player: p, selected: opponent == p, showRating: true) {
                            opponent = p; closeSearch()
                        }
                    }
                }
            }
        }
        .frame(height: 212)
    }

    // MARK: Match length

    private var lengthSection: some View {
        VStack(alignment: .leading, spacing: 11) {
            Eyebrow("Match length")
            HStack(spacing: 8) {
                ForEach(Self.lengths, id: \.n) { item in
                    let on = bestOf == item.n
                    Button { bestOf = item.n } label: {
                        VStack(spacing: 5) {
                            Text("\(item.n)")
                                .font(FMFont.mono(25, weight: .bold))
                                .foregroundStyle(on ? FMColor.fgInverse : FMColor.fg1)
                            Text(item.label.uppercased())
                                .font(FMFont.ui(9, weight: .semibold))
                                .tracking(1.2)
                                .foregroundStyle(on ? FMColor.fgInverse.opacity(0.7) : FMColor.fgMuted)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 12)
                        .padding(.bottom, 9)
                        .background(on ? FMColor.ball500 : FMColor.ink800)
                        .fmRoundedBorder(radius: FMRadius.md, color: on ? FMColor.ball500 : FMColor.borderSubtle)
                    }
                    .buttonStyle(.plain)
                }
            }
            Text("First to \(gamesToWin) \(gamesToWin == 1 ? "game" : "games"). Games to 11, win by 2.")
                .font(FMFont.ui(12.5))
                .foregroundStyle(FMColor.fg3)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 18)
    }

    // MARK: Rated

    private var ratedSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Eyebrow("Rated match")
                Spacer()
                if solo {
                    Text("NO OPPONENT · UNAVAILABLE")
                        .font(FMFont.ui(10, weight: .medium))
                        .tracking(1.0)
                        .foregroundStyle(FMColor.fgMuted)
                }
            }
            Button { if !solo { rated.toggle() } } label: {
                HStack(spacing: 14) {
                    ToggleTrack(on: rated)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(rated ? "Counts toward rating" : "Just for fun")
                            .font(FMFont.ui(15, weight: .semibold))
                            .foregroundStyle(FMColor.fg1)
                        Text(ratedSubtitle)
                            .font(FMFont.ui(12))
                            .foregroundStyle(FMColor.fg3)
                    }
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .background(FMColor.ink800)
                .fmRoundedBorder(radius: FMRadius.lg, color: rated ? FMColor.ball500 : FMColor.borderSubtle)
                .opacity(solo ? 0.5 : 1)
            }
            .buttonStyle(.plain)
            .disabled(solo)
        }
        .padding(.horizontal, 16)
    }

    private var ratedSubtitle: String {
        if solo { return "Pick an opponent to make this rated." }
        return rated ? "Result will adjust both ratings." : "Flip on to make this rated."
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: 10) {
            Button(action: onCancel) {
                Text("Cancel")
                    .font(FMFont.ui(15, weight: .semibold))
                    .foregroundStyle(FMColor.fg2)
                    .padding(.horizontal, 22)
                    .frame(height: 50)
                    .fmRoundedBorder(radius: 13, color: FMColor.borderDefault)
            }
            .buttonStyle(.plain)

            Button(action: onStart) {
                HStack(spacing: 8) {
                    Text("Start match").font(FMFont.ui(16, weight: .bold))
                    Image(systemName: "arrow.right").font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(FMColor.fgInverse)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(BallGradient())
                .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
                .shadow(color: FMColor.ball500.opacity(0.32), radius: 11, y: 8)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .overlay(alignment: .top) { Rectangle().fill(FMColor.ink700).frame(height: 1) }
    }

    private func toggle(_ p: MatchPlayer) { opponent = (opponent == p) ? nil : p }
    private func closeSearch() { searching = false; query = ""; searchFocused = false }
}

// MARK: - Opponent card

private struct OpponentCard: View {
    let player: MatchPlayer
    let selected: Bool
    let showRating: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                MatchAvatar(player: player, size: 36)
                VStack(alignment: .leading, spacing: 1) {
                    Text(player.handle)
                        .font(FMFont.ui(14, weight: .semibold))
                        .foregroundStyle(FMColor.fg1)
                        .lineLimit(1)
                    Text("REGISTERED")
                        .font(FMFont.ui(9, weight: .medium))
                        .tracking(0.9)
                        .foregroundStyle(FMColor.fgMuted)
                        .lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if showRating {
                    Text("★ \(player.rating)")
                        .font(FMFont.mono(11, weight: .bold))
                        .foregroundStyle(FMColor.ball500)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(FMColor.bgAccentSoft)
                        .clipShape(Capsule())
                }
                SelectDot(selected: selected)
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
            .background(selected ? FMColor.bgAccentSoft : FMColor.ink800)
            .fmRoundedBorder(radius: FMRadius.md, color: selected ? FMColor.ball500 : FMColor.borderSubtle)
        }
        .buttonStyle(.plain)
    }
}

private struct SelectDot: View {
    let selected: Bool
    var body: some View {
        ZStack {
            Circle()
                .fill(selected ? FMColor.ball500 : Color.clear)
                .overlay { if !selected { Circle().stroke(FMColor.ink500, lineWidth: 1.5) } }
                .frame(width: 20, height: 20)
            if selected {
                Image(systemName: "checkmark")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundStyle(FMColor.fgInverse)
            }
        }
    }
}

// MARK: - Shared bits

/// Animated pill toggle track matching the prototype's custom switch.
struct ToggleTrack: View {
    let on: Bool
    var body: some View {
        ZStack(alignment: on ? .trailing : .leading) {
            Capsule().fill(on ? FMColor.ball500 : FMColor.ink600)
            Circle().fill(.white).padding(3)
        }
        .frame(width: 48, height: 28)
        .animation(.spring(response: 0.25, dampingFraction: 0.8), value: on)
    }
}

/// Bebas-style display title with an orange accent period — "NEW MATCH."
struct DisplayTitle: View {
    let text: String
    var size: CGFloat = 40
    init(_ text: String, size: CGFloat = 40) { self.text = text; self.size = size }
    var body: some View {
        (Text(text).foregroundStyle(FMColor.fg1)
            + Text(".").foregroundStyle(FMColor.ball500))
            .font(FMFont.display(size))
            .tracking(0.5)
    }
}

/// Uppercase overline label (no leading dot — matches the prototype `Overline`).
struct Eyebrow: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View {
        Text(text.uppercased())
            .font(FMFont.ui(11, weight: .semibold))
            .tracking(1.6)
            .foregroundStyle(FMColor.fg3)
    }
}

/// The hero orange gradient used on primary buttons across the flow.
struct BallGradient: View {
    var body: some View {
        LinearGradient(colors: [FMColor.ball400, FMColor.ball600],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
