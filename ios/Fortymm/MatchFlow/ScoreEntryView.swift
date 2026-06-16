import SwiftUI

/// Screen 2 — live, game-by-game score entry, plus edit mode for completed
/// games. Scores are native `.numberPad` text fields (no in-app keypad);
/// advancing between sides / submitting is done via the on-screen action row
/// and by tapping a score field directly.
struct ScoreEntryView: View {
    let config: MatchConfig
    /// Games already entered for this match, in order (game 1…N). Empty for a
    /// new match; populated when resuming a live one so the user continues from
    /// where they left off rather than re-entering scored games.
    var initialGames: [Game] = []
    /// Hand the completed games (in order, game 1…N) up to the coordinator,
    /// which posts them to the API and renders the server's result.
    var onPost: ([Game]) -> Void
    var onExit: () -> Void

    // One slot per game in the match; any slot can be entered or edited in any
    // order by tapping its scoreline chip. Populated on first appear from bestOf.
    @State private var games: [Game] = []
    @State private var active = 0          // index being entered
    @State private var editing = false     // true when re-entering an already-complete game
    @FocusState private var focus: MatchSide?

    private var you: MatchPlayer { MatchSeed.me }
    private var opp: MatchPlayer { config.opponent ?? .guest }

    private var current: Game { games.indices.contains(active) ? games[active] : Game() }
    private var currentValid: Bool { MatchRules.gameComplete(current) }

    /// Tally shown in the VS column — includes the current game if it's complete.
    private var setsDisplay: SetScore {
        var games = self.games.enumerated().filter { $0.offset != active }.map(\.element)
        if currentValid { games.append(current) }
        return MatchRules.setsWon(games)
    }
    /// True when the games entered so far form a complete, decided match — i.e.
    /// there's a valid result to Post. Uses the same canonical rule as `post()`
    /// so the Post button never appears for games the server would reject, and
    /// never goes dead when it does appear.
    private var deciding: Bool {
        MatchRules.gamesThroughDecider(games, bestOf: config.bestOf) != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            scoreboard
            Spacer().frame(height: 12)
            scoreline
            actionRow
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            Spacer(minLength: 0)
            hint
        }
        .background(FMColor.ink950.ignoresSafeArea())
        .onAppear {
            if games.isEmpty {
                // Seed every slot from `initialGames` (already-entered games when
                // resuming), padded/clipped to the match length, then land on the
                // first slot still needing a score.
                var seeded = Array(initialGames.prefix(config.bestOf))
                if seeded.count < config.bestOf {
                    seeded += Array(repeating: Game(), count: config.bestOf - seeded.count)
                }
                games = seeded
                active = seeded.firstIndex { !MatchRules.gameComplete($0) } ?? 0
            }
            focusYou()
        }
        // Switching game (or editing) → raise the keypad on your side.
        .onChange(of: active) { _, _ in focusYou() }
        .onChange(of: editing) { _, _ in focusYou() }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button(action: onExit) {
                    Image(systemName: "arrow.left")
                        .font(.system(size: 20, weight: .medium))
                        .foregroundStyle(FMColor.fg3)
                        .frame(width: 40, height: 40)
                }
                .buttonStyle(.plain)
                Spacer()
                MetaChip(text: "BO\(config.bestOf)", accent: false)
                MetaChip(text: config.rated ? "Rated" : "Casual", accent: config.rated)
            }
            DisplayTitle(editing ? "EDIT GAME \(active + 1) SCORE" : "ENTER GAME \(active + 1) SCORE", size: 32)
                .lineLimit(1)
                .minimumScaleFactor(0.6)
                .padding(.horizontal, 4)
                .padding(.bottom, 14)
        }
        .padding(.horizontal, 14)
        .padding(.top, 6)
    }

    // MARK: Scoreboard

    private var scoreboard: some View {
        HStack(spacing: 0) {
            ScorePanel(player: you, isYou: true, value: bind(.you),
                       focused: focus == .you, focusBinding: $focus, side: .you)
            Rectangle().fill(FMColor.ink600).frame(width: 1)
            VStack(spacing: 8) {
                Text("VS").font(FMFont.display(22)).tracking(1.0).foregroundStyle(FMColor.ink400)
                HStack(spacing: 3) {
                    Text("\(setsDisplay.a)")
                    Text("-").foregroundStyle(FMColor.fgMuted)
                    Text("\(setsDisplay.b)")
                }
                .font(FMFont.mono(14, weight: .bold))
                .foregroundStyle(FMColor.fg2)
            }
            .frame(width: 62)
            .frame(maxHeight: .infinity)
            .background(FMColor.ink950)
            Rectangle().fill(FMColor.ink600).frame(width: 1)
            ScorePanel(player: opp, isYou: false, value: bind(.opponent),
                       focused: focus == .opponent, focusBinding: $focus, side: .opponent)
        }
        .frame(minHeight: 172)
        .fixedSize(horizontal: false, vertical: true)
        .background(FMColor.ink900)
        .fmRoundedBorder(radius: 16, color: FMColor.borderSubtle)
        .padding(.horizontal, 16)
    }

    // MARK: Scoreline

    private var scoreline: some View {
        HStack(spacing: 9) {
            Text("SCORE\nLINE")
                .font(FMFont.ui(9, weight: .semibold))
                .tracking(1.2)
                .foregroundStyle(FMColor.fgMuted)
            HStack(spacing: 7) {
                ForEach(0..<config.bestOf, id: \.self) { i in
                    let g = games.indices.contains(i) ? games[i] : Game()
                    GameChip(index: i, game: g, active: i == active) {
                        if i != active { selectGame(i) }
                    }
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(12)
        .background(FMColor.ink900)
        .fmRoundedBorder(radius: FMRadius.lg, color: FMColor.borderSubtle)
        .padding(.horizontal, 16)
    }

    // MARK: Action row

    @ViewBuilder
    private var actionRow: some View {
        if deciding {
            // A valid result that reaches `need` ends the match — offer Post,
            // whether reached by live entry or by editing an earlier game (e.g.
            // fixing game 2 that turns out to clinch the match).
            HStack(spacing: 12) {
                if editing {
                    clearButton
                } else {
                    Text("This finishes the match — post the result.")
                        .font(FMFont.ui(12, weight: .medium))
                        .foregroundStyle(FMColor.fg3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                postButton(expand: editing)
            }
        } else if editing {
            HStack(spacing: 10) {
                clearButton
                PrimaryAction(title: "Save changes", filled: currentValid, enabled: currentValid, action: saveEdit)
            }
        } else {
            // Neutral "save & next" — raised dark surface, not the hero gradient.
            Button(action: saveNext) {
                HStack(spacing: 8) {
                    Text("Save game & next").font(FMFont.ui(16, weight: .bold))
                    Image(systemName: "arrow.right").font(.system(size: 16, weight: .bold))
                }
                .foregroundStyle(currentValid ? FMColor.fg1 : FMColor.fgMuted)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(currentValid ? FMColor.ink700 : FMColor.ink800)
                .fmRoundedBorder(radius: 13, color: currentValid ? FMColor.borderDefault : FMColor.borderSubtle)
            }
            .buttonStyle(.plain)
            .disabled(!currentValid)
        }
    }

    private var clearButton: some View {
        Button(action: clearEdit) {
            Text("Clear")
                .font(FMFont.ui(15, weight: .semibold))
                .foregroundStyle(FMColor.fg2)
                .padding(.horizontal, 20)
                .frame(height: 48)
                .fmRoundedBorder(radius: 13, color: FMColor.borderDefault)
        }
        .buttonStyle(.plain)
    }

    private func postButton(expand: Bool) -> some View {
        Button(action: post) {
            HStack(spacing: 8) {
                Text("Post result").font(FMFont.ui(16, weight: .bold))
                if expand { Image(systemName: "arrow.right").font(.system(size: 15, weight: .bold)) }
            }
            .foregroundStyle(FMColor.fgInverse)
            .padding(.horizontal, 26)
            .frame(maxWidth: expand ? .infinity : nil)
            .frame(height: 50)
            .background(BallGradient())
            .clipShape(RoundedRectangle(cornerRadius: 13, style: .continuous))
            .shadow(color: FMColor.ball500.opacity(0.32), radius: 11, y: 8)
        }
        .buttonStyle(.plain)
    }

    private var hint: some View {
        Text("Tap a score to bring up the keypad.")
            .font(FMFont.ui(12, weight: .medium))
            .foregroundStyle(FMColor.fgMuted)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 28)
            .padding(.bottom, 24)
    }

    // MARK: Binding + actions

    /// Two-digit numeric binding for one side, clamped to 40 (matches prototype).
    private func bind(_ side: MatchSide) -> Binding<String> {
        Binding(
            get: {
                let v = side == .you ? current.a : current.b
                return v.map(String.init) ?? ""
            },
            set: { raw in
                var digits = raw.filter(\.isNumber)
                if digits.count > 2 { digits = String(digits.suffix(2)) }
                let n = digits.isEmpty ? nil : min(40, Int(digits) ?? 0)
                setCurrent { side == .you ? ($0.a = n) : ($0.b = n) }
            }
        )
    }

    private func setCurrent(_ mutate: (inout Game) -> Void) {
        guard games.indices.contains(active) else { return }
        mutate(&games[active])
    }

    private func focusYou() {
        DispatchQueue.main.async { focus = .you }
    }

    private func saveNext() {
        guard currentValid else { return }
        // Advance to the next still-incomplete game (wrapping); stay put if the
        // match is fully scored.
        if let next = nextIncompleteIndex() { active = next }
        editing = false
    }

    /// Jump to any game's slot. Re-entering an already-complete game opens edit
    /// mode (Clear / Save changes); an empty slot is plain entry.
    private func selectGame(_ i: Int) {
        guard games.indices.contains(i) else { return }
        active = i
        editing = MatchRules.gameComplete(games[i])
    }

    /// First incomplete slot searching forward from `active` and wrapping.
    private func nextIncompleteIndex() -> Int? {
        guard !games.isEmpty else { return nil }
        return (1...games.count)
            .map { (active + $0) % games.count }
            .first { !MatchRules.gameComplete(games[$0]) }
    }

    private func clearEdit() {
        setCurrent { $0 = Game() }
        focusYou()
    }

    private func saveEdit() {
        guard currentValid else { return }
        editing = false
        // Return to the first still-incomplete game, else stay on the last.
        if let firstIncomplete = games.indices.first(where: { $0 != active && !MatchRules.gameComplete(games[$0]) }) {
            active = firstIncomplete
        } else {
            active = games.count - 1
        }
    }

    private func post() {
        // The completed games in play order, game 1 up to and including the
        // decider — anything entered past the decider is dropped, matching the
        // server's finalize rules. The coordinator posts these to
        // `POST /v1/matches/{id}/results`; the server computes sets won, the
        // winner, and any rating change — so we don't here.
        guard let finalGames = MatchRules.gamesThroughDecider(games, bestOf: config.bestOf) else { return }
        focus = nil
        onPost(finalGames)
    }
}

// MARK: - Score panel (one side)

private struct ScorePanel: View {
    let player: MatchPlayer
    let isYou: Bool
    @Binding var value: String
    let focused: Bool
    var focusBinding: FocusState<MatchSide?>.Binding
    let side: MatchSide

    var body: some View {
        VStack(alignment: isYou ? .leading : .trailing, spacing: 0) {
            HStack(spacing: 9) {
                if isYou { MatchAvatar(player: player, size: 32, glow: true) }
                Text(player.handle)
                    .font(FMFont.ui(14, weight: .semibold))
                    .foregroundStyle(FMColor.fg1)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: isYou ? .leading : .trailing)
                if !isYou { MatchAvatar(player: player, size: 32) }
            }
            Spacer(minLength: 12)
            TextField("", text: $value, prompt: Text("0").foregroundStyle(FMColor.ink600))
                .keyboardType(.numberPad)
                .focused(focusBinding, equals: side)
                .multilineTextAlignment(isYou ? .leading : .trailing)
                .font(FMFont.mono(66, weight: .bold))
                .foregroundStyle(value.isEmpty ? FMColor.ink600 : (focused ? FMColor.ball500 : FMColor.fg1))
                .tint(FMColor.ball500)
                .frame(maxWidth: .infinity, alignment: isYou ? .leading : .trailing)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background { if focused { focusTint } }
        .contentShape(Rectangle())
        .onTapGesture { focusBinding.wrappedValue = side }
    }

    private var focusTint: LinearGradient {
        LinearGradient(
            colors: [FMColor.ball500.opacity(0.16), FMColor.ball500.opacity(0.02)],
            startPoint: .top, endPoint: .bottom
        )
    }
}

// MARK: - Scoreline chip

private struct GameChip: View {
    let index: Int
    let game: Game
    let active: Bool
    let onTap: () -> Void

    private var done: Bool { MatchRules.gameComplete(game) }

    var body: some View {
        Button(action: onTap) {
            VStack(spacing: 4) {
                Text("G\(index + 1)")
                    .font(FMFont.ui(9, weight: .semibold))
                    .tracking(0.9)
                    .foregroundStyle(active ? FMColor.ball500 : FMColor.fgMuted)
                Group {
                    if done, let a = game.a, let b = game.b {
                        HStack(spacing: 2) {
                            Text("\(a)").foregroundStyle(a > b ? FMColor.serve500 : FMColor.fg2)
                            Text("-").foregroundStyle(FMColor.fgMuted)
                            Text("\(b)").foregroundStyle(b > a ? FMColor.serve500 : FMColor.fg2)
                        }
                    } else {
                        Text("– –").tracking(2).foregroundStyle(FMColor.ink500)
                    }
                }
                .font(FMFont.mono(13, weight: .bold))
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            }
            // No fixed min width: chips share the row evenly and shrink to fit so
            // a full best-of-7 scoreline never forces the screen wider than it is
            // (which on narrow phones pushed the whole layout past both edges).
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 4)
            .padding(.top, 8)
            .padding(.bottom, 7)
            .background(active ? FMColor.bgAccentSoft : FMColor.ink800)
            .fmRoundedBorder(radius: FMRadius.md,
                             color: active ? FMColor.ball500 : (done ? FMColor.borderDefault : FMColor.borderSubtle),
                             lineWidth: 1.5)
            .opacity(!done && !active ? 0.5 : 1)
        }
        .buttonStyle(.plain)
        // Any game can be selected and edited in any order; only the slot that's
        // already active is inert.
        .disabled(active)
    }
}

// MARK: - Small shared pieces

private struct MetaChip: View {
    let text: String
    let accent: Bool
    var body: some View {
        Text(text.uppercased())
            .font(FMFont.ui(10, weight: .semibold))
            .tracking(1.0)
            .foregroundStyle(accent ? FMColor.ball500 : FMColor.fg3)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(accent ? FMColor.bgAccentSoft : FMColor.ink800)
            .overlay(Capsule().stroke(accent ? FMColor.ball500.opacity(0.4) : FMColor.borderSubtle, lineWidth: 1))
            .clipShape(Capsule())
    }
}

private struct PrimaryAction: View {
    let title: String
    let filled: Bool
    let enabled: Bool
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(title).font(FMFont.ui(16, weight: .bold))
                Image(systemName: "arrow.right").font(.system(size: 15, weight: .bold))
            }
            .foregroundStyle(filled ? FMColor.fgInverse : FMColor.fgMuted)
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(filled ? AnyView(BallGradient()) : AnyView(FMColor.ink800))
            .fmRoundedBorder(radius: 13, color: filled ? .clear : FMColor.borderSubtle)
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
    }
}
