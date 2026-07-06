import SwiftUI

/// Screen 2 — live, game-by-game score entry, plus edit mode for completed
/// games. Scores are native `.numberPad` text fields (no in-app keypad);
/// advancing between sides / submitting is done via the on-screen action row
/// and by tapping a score field directly.
struct ScoreEntryView: View {
    let config: MatchConfig
    /// The server match id these scores belong to, and which side ("you") the
    /// signed-in player is. Unused today — carried so the per-game write path
    /// (next task) can address the shared scratchpad without re-threading them.
    let matchId: UUID?
    let yourSideNumber: Int
    /// Gateway for the per-game scratchpad writes fired on save. Injected from
    /// `MatchFlowView` (which holds the same instance it posts results through)
    /// so tests/previews can substitute a stub; defaults to the shared client.
    var service: MatchService = .shared
    /// Games already entered for this match, in order (game 1…N). Empty for a
    /// new match; populated when resuming a live one so the user continues from
    /// where they left off rather than re-entering scored games. Each slot
    /// carries its scratchpad sync state alongside the points (see `ScoredGame`);
    /// scoring reads only `.points`, so today's board is unchanged.
    var initialGames: [ScoredGame] = []
    /// Hand the completed games (in order, game 1…N) up to the coordinator,
    /// which posts them to the API and renders the server's result.
    var onPost: ([Game]) -> Void
    /// True when this board is a *correction* of a posted result (seeded from
    /// the standing proposal; posting supersedes it). Only changes copy — the
    /// entry/edit mechanics are identical to live scoring.
    var correction: Bool = false
    /// The signed-in player's username, so the "you" panel labels your side with
    /// the same handle the posted result, list, and detail views show (and that
    /// the web scoreboard shows) — rather than a generic "You". Falls back to the
    /// `MatchSeed.me` placeholder when the session hasn't surfaced a username yet.
    var meName: String? = nil
    var onExit: () -> Void

    // One slot per game in the match; any slot can be entered or edited in any
    // order by tapping its scoreline chip. Populated on first appear from bestOf.
    // Each slot pairs the entered points with their scratchpad sync state; the
    // scoring UI reads `.points`, leaving `sync` for the (future) write path.
    @State private var games: [ScoredGame] = []
    @State private var active = 0          // index being entered
    @State private var editing = false     // true when re-entering an already-complete game
    // The game index whose 409 conflict the user is currently resolving, driving
    // the keep-committed / use-mine dialog. Set when a conflict chip is tapped, or
    // when a conflict lands on the game that's still active; cleared on decision.
    @State private var resolving: Int?
    // The game index whose committed scratchpad score the user is confirming a
    // clear of, driving the destructive clear dialog. Set when Clear is tapped on
    // a game that HAS a server-committed score; cleared on decision. A never-
    // committed game clears locally without ever setting this.
    @State private var clearing: Int?
    // Game numbers cleared while a *create* was still in flight, so the DELETE is
    // deferred until that write resolves (we don't yet know if a row landed).
    // `applyWriteResult` fires the DELETE and consumes the entry. Avoids both an
    // orphaned committed row and a DELETE that races ahead of the create.
    @State private var pendingClearDeletes: Set<Int> = []
    // Raw text backing the two score fields for the *active* game. Kept verbatim
    // so a malformed entry (extra characters, too many digits) is shown back to
    // the user and flagged inline rather than silently stripped/truncated into a
    // different number. Re-seeded from the stored Int? whenever the active slot
    // changes. See `bind(_:)` / issue #627.
    @State private var rawYou = ""
    @State private var rawOpp = ""
    @FocusState private var focus: MatchSide?

    private var you: MatchPlayer {
        guard let name = meName, !name.isEmpty else { return MatchSeed.me }
        return MatchPlayer(handle: name, initials: name.fmInitials, you: true)
    }
    private var opp: MatchPlayer { config.opponent ?? .guest }

    private var current: Game { games.indices.contains(active) ? games[active].points : Game() }
    private var currentValid: Bool { MatchRules.gameComplete(current) }

    /// Tally shown in the VS column. `setsWon` ignores incomplete games *and* now
    /// caps the count at the decider, so a board scored past the clinch still shows
    /// the decided score (e.g. 3–0), never a phantom tally from overrun games.
    private var setsDisplay: SetScore { MatchRules.setsWon(games.map(\.points), bestOf: config.bestOf) }
    /// True when the games entered so far form a complete, decided match — i.e.
    /// there's a valid result to Post. Uses the same canonical rule as `post()`
    /// so the Post button never appears for games the server would reject, and
    /// never goes dead when it does appear.
    private var deciding: Bool {
        MatchRules.decidedGames(games.map(\.points), bestOf: config.bestOf) != nil
    }

    var body: some View {
        VStack(spacing: 0) {
            header
            scoreboard
            scoreError
            Spacer().frame(height: 12)
            scoreline
            overrunHint
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
                    seeded += Array(
                        repeating: ScoredGame(points: Game(), sync: .localOnly),
                        count: config.bestOf - seeded.count
                    )
                }
                games = seeded
                active = seeded.firstIndex { !MatchRules.gameComplete($0.points) } ?? 0
            }
            syncRawFromActive()
            focusYou()
        }
        // Switching game (or editing) → raise the keypad on your side and reset
        // the raw fields to the newly-active slot's stored scores.
        .onChange(of: active) { _, _ in syncRawFromActive(); focusYou() }
        .onChange(of: editing) { _, _ in focusYou() }
        // A 409 leaves the slot in `.conflict`, holding the server's committed
        // score alongside our entry. Make the user re-decide against reality:
        // keep the committed score, or overwrite it with theirs — mirroring web's
        // keepCommittedScore / overwriteWithMyScore.
        .confirmationDialog(
            "Score conflict",
            isPresented: Binding(
                get: { resolving != nil },
                set: { if !$0 { resolving = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let c = resolvingConflict, let i = resolving {
                Button("Keep their score") { keepCommitted(i, committed: c.committed, version: c.version) }
                Button("Use my score") { useMyScore(i) }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            if let c = resolvingConflict, let i = resolving {
                Text("They saved \(scoreText(c.committed)). You entered \(scoreText(games[i].points)).")
            }
        }
        // Clearing a game that HAS a server-committed score removes it from the
        // shared scratchpad — confirm first, then DELETE. A never-committed clear
        // never reaches here (it wipes locally). Mirrors web's confirm-then-delete.
        .confirmationDialog(
            "Clear game \((clearing ?? 0) + 1)?",
            isPresented: Binding(
                get: { clearing != nil },
                set: { if !$0 { clearing = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let i = clearing {
                Button("Clear", role: .destructive) { confirmClear(i) }
                Button("Cancel", role: .cancel) {}
            }
        } message: {
            Text("This removes the saved score.")
        }
    }

    // MARK: Score error

    /// Inline flag shown when either field holds a malformed entry — non-digit
    /// characters or more than three digits. The Save / Post buttons are already
    /// blocked (a malformed field parses to `nil`, so the game is incomplete);
    /// this tells the user *why* rather than silently coercing their input.
    @ViewBuilder
    private var scoreError: some View {
        if malformedField(rawYou) || malformedField(rawOpp) {
            Text("Enter each score as digits only (up to 3) — nothing was changed for you.")
                .font(FMFont.ui(12, weight: .medium))
                .foregroundStyle(FMColor.loss)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.top, 10)
        }
    }

    // MARK: Overrun hint

    /// Inline, purely-informational callout shown when the board has a completed
    /// game *past* the decider (an overrun). Post is already unavailable — the
    /// single source of truth for postability is `decidedGames`/`deciding`, which
    /// returns nil for an overrun, so this is NOT a second disable gate. It only
    /// tells the user which trailing games to clear (tap a chip → Clear, reusing
    /// the existing confirm-clear → delete flow) so the decided board can be posted.
    @ViewBuilder
    private var overrunHint: some View {
        if let decidedAt = MatchRules.overrunDecider(games.map(\.points), bestOf: config.bestOf) {
            Text("The match is decided at game \(decidedAt) — clear the games after it before posting.")
                .font(FMFont.ui(12, weight: .medium))
                .foregroundStyle(FMColor.warn)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .padding(.horizontal, 24)
                .padding(.top, 10)
        }
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
                    let g = games.indices.contains(i) ? games[i].points : Game()
                    let s = games.indices.contains(i) ? games[i].sync : .localOnly
                    GameChip(index: i, game: g, sync: s, active: i == active, locked: lockedForEntry(i)) {
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
                    Text(correction
                         ? "Sending posts the corrected score for \(opp.handle) to accept."
                         : "This finishes the match — post the result.")
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
                Text(correction ? "Send corrected score" : "Post result")
                    .font(FMFont.ui(16, weight: .bold))
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

    /// Text binding for one side's score field. The raw text is kept verbatim
    /// (so a malformed entry is shown back and flagged by `scoreError`) and
    /// parsed into the model only when it's a clean score: a malformed entry
    /// stores `nil`, leaving the game incomplete and Save / Post blocked, rather
    /// than silently stripping non-digits or truncating to the last two as the
    /// prototype did (issue #627).
    private func bind(_ side: MatchSide) -> Binding<String> {
        Binding(
            get: { side == .you ? rawYou : rawOpp },
            set: { raw in
                let cleaned = Self.normalizeScoreText(raw)
                if side == .you { rawYou = cleaned } else { rawOpp = cleaned }
                let n = Self.parseScore(cleaned)
                setCurrent { side == .you ? ($0.a = n) : ($0.b = n) }
            }
        )
    }

    /// A clean score, or `nil` for empty *and* for malformed input. Accepts only
    /// 1–3 ASCII digits; anything else (a decimal point, a pasted `11.5`, more
    /// than three digits like `999999`) parses to `nil` so it can't masquerade
    /// as a real score. Legality under table-tennis rules is enforced separately
    /// by `MatchRules.illegalScoreReason`.
    private static func parseScore(_ raw: String) -> Int? {
        guard !raw.isEmpty, raw.count <= 3,
              raw.allSatisfy({ $0 >= "0" && $0 <= "9" }) else { return nil }
        return Int(raw)
    }

    /// Collapse a clean digit run to its canonical form so the field shows the
    /// same number it evaluates to: "011" → "11", "00" → "0". A lone "0" and the
    /// empty field are left as-is, and a malformed entry (non-digits, >3 digits)
    /// is returned verbatim so `scoreError` still flags it rather than being
    /// silently rewritten. Fixes the leading-zeros half of #446.
    private static func normalizeScoreText(_ raw: String) -> String {
        guard let n = parseScore(raw) else { return raw }
        return String(n)
    }

    /// True when the field holds something the user typed/pasted that isn't a
    /// clean score (non-empty but unparseable) — drives the inline flag.
    private func malformedField(_ raw: String) -> Bool {
        !raw.isEmpty && Self.parseScore(raw) == nil
    }

    /// Re-seed the raw score fields from the active game's stored values.
    private func syncRawFromActive() {
        rawYou = current.a.map(String.init) ?? ""
        rawOpp = current.b.map(String.init) ?? ""
    }

    private func setCurrent(_ mutate: (inout Game) -> Void) {
        guard games.indices.contains(active) else { return }
        // Mutate the active slot's points only; its sync state is left untouched
        // (nothing consumes it yet, and no write fires this task).
        mutate(&games[active].points)
    }

    private func focusYou() {
        DispatchQueue.main.async { focus = .you }
    }

    private func saveNext() {
        guard currentValid else { return }
        // The slot just saved — captured before we advance `active` off it.
        let saved = active
        // Advance to the next still-incomplete game (wrapping); stay put if the
        // match is fully scored.
        if let next = nextIncompleteIndex() { active = next }
        editing = false
        // Fire the optimistic scratchpad write for the game we just left; the
        // UI has already advanced (fire-and-forget).
        fireWrite(for: saved)
    }

    /// True for an *empty* slot strictly past the decider once a side has clinched:
    /// scoring it would overrun a decided match, so it can't be entered. Already-
    /// scored slots stay tappable (so an overrun game can be selected and cleared),
    /// and the decider game and everything before it stay editable (so the user can
    /// still fix an earlier game). `deciderGameNumber` is 1-based, so game numbers
    /// strictly past it are exactly the indices `>= decider`.
    private func lockedForEntry(_ i: Int) -> Bool {
        guard games.indices.contains(i),
              let decider = MatchRules.deciderGameNumber(games.map(\.points), bestOf: config.bestOf)
        else { return false }
        return i >= decider && !MatchRules.gameComplete(games[i].points)
    }

    /// Jump to any game's slot. Re-entering an already-complete game opens edit
    /// mode (Clear / Save changes); an empty slot is plain entry. An empty slot
    /// past the decider is locked (see `lockedForEntry`) and ignored.
    private func selectGame(_ i: Int) {
        guard games.indices.contains(i), !lockedForEntry(i) else { return }
        active = i
        editing = MatchRules.gameComplete(games[i].points)
        // A conflicted slot demands an explicit keep-mine / use-theirs decision —
        // surface it as soon as the user lands on that game.
        if case .conflict = games[i].sync { resolving = i }
    }

    /// First incomplete slot searching forward from `active` and wrapping. Slots
    /// locked past the decider are skipped, so saving the clinching game never
    /// advances the user into a game they can't enter (the match is decided —
    /// `deciding` now offers Post instead).
    private func nextIncompleteIndex() -> Int? {
        guard !games.isEmpty else { return nil }
        return (1...games.count)
            .map { (active + $0) % games.count }
            .first { !MatchRules.gameComplete(games[$0].points) && !lockedForEntry($0) }
    }

    /// Clear the active game. Sync-state-aware: a game that has (or may be about to
    /// have) a server-committed row — `.saved`, `.conflict`, an in-flight `.saving`,
    /// or a `.failed` that had committed before failing — lives on the shared
    /// scratchpad, so clearing it must confirm and DELETE via the clear dialog. A
    /// game that never reached the server (`.localOnly`, or a `.failed` first
    /// create) wipes purely locally with no dialog and no network. Correction
    /// boards seed every slot `.localOnly`, so they always take the local branch
    /// (no DELETE against a frozen scratchpad).
    private func clearEdit() {
        guard games.indices.contains(active) else { return }
        switch games[active].sync {
        case .saved, .conflict, .saving:
            // A committed row exists, or a write is in flight that may leave one —
            // confirm, then DELETE (or defer the DELETE for an in-flight create).
            clearing = active
        case .failed(let committedVersion):
            // A committed row exists only if a prior write succeeded before the
            // failure; otherwise the failed create left nothing to delete.
            if committedVersion != nil { clearing = active } else { clearLocally(active) }
        case .localOnly:
            clearLocally(active)
        }
    }

    /// Wipe a slot back to an empty local game (`.localOnly`) with no network
    /// call — the never-committed clear path, and what a confirmed DELETE resets
    /// the slot to. Re-seeds the raw fields and refocuses when it's the active
    /// game, as the old `clearEdit` did.
    private func clearLocally(_ i: Int) {
        guard games.indices.contains(i) else { return }
        games[i].points = Game()
        games[i].sync = .localOnly
        if i == active {
            syncRawFromActive()
            focusYou()
        }
    }

    /// Confirmed clear of a committed (or in-flight) game: remove its scratchpad
    /// row and reset the slot locally.
    ///
    /// - An in-flight *create* (`.saving(nil)`) hasn't told us whether a row
    ///   landed, so the DELETE is *deferred* (`pendingClearDeletes`) until the
    ///   write resolves — firing it now could race ahead of the create and leave
    ///   an orphan.
    /// - Otherwise a row exists (or an in-flight update is over one — the DELETE
    ///   and that PUT converge on "no row" in either order), so DELETE now,
    ///   fire-and-forget. A thrown DELETE still leaves the slot cleared; a later
    ///   post's divergence guard reconciles the server.
    ///
    /// A nil `matchId` (shouldn't happen once live scoring is reached) still clears
    /// locally.
    private func confirmClear(_ i: Int) {
        guard games.indices.contains(i) else { return }
        let gameNumber = i + 1
        if case .saving(nil) = games[i].sync {
            pendingClearDeletes.insert(gameNumber)
        } else if let matchId {
            Task { try? await service.deleteGameScore(matchId: matchId, gameNumber: gameNumber) }
        }
        clearLocally(i)
        clearing = nil
    }

    private func saveEdit() {
        guard currentValid else { return }
        // The slot just edited — captured before we move `active` off it.
        let saved = active
        editing = false
        // Return to the first still-incomplete game, else stay on the last.
        if let firstIncomplete = games.indices.first(where: { $0 != active && !MatchRules.gameComplete(games[$0].points) }) {
            active = firstIncomplete
        } else {
            active = games.count - 1
        }
        // Persist the edit to the shared scratchpad (fire-and-forget).
        fireWrite(for: saved)
    }

    // MARK: Per-game scratchpad writes (fire-and-forget)

    /// The result of one in-flight per-game write, handed back to the reducer.
    private enum WriteOutcome {
        /// The verb returned — either the new version on success, or the 409
        /// conflict body.
        case completed(Result<Int, GameScoreConflictDTO>)
        /// The verb threw (offline, decoding, or any non-409 failure).
        case threw
    }

    /// Fire the optimistic scratchpad write for the slot at `index` (game number
    /// `index + 1`), having already advanced the UI. This never blocks the save.
    ///
    /// No-op on a *correction* board: once a result is proposed the scratchpad is
    /// frozen, so a per-game write would 409 — corrections post through `post()`
    /// alone. Also a no-op when there's no server match to address (`matchId` is
    /// nil, which shouldn't happen once live scoring is reached).
    ///
    /// The slot's current sync decides the verb via `GameWriteIntent.forWrite`; a
    /// `nil` intent means a write is already in flight, so we don't double-fire.
    /// The slot is marked `.saving`, the write runs in a detached `Task`, and its
    /// result is reduced back on the main actor by `applyWriteResult`.
    private func fireWrite(for index: Int) {
        guard !correction else { return }
        guard let matchId else { return }
        guard games.indices.contains(index) else { return }

        guard let intent = GameWriteIntent.forWrite(games[index].sync) else { return }

        let gameNumber = index + 1
        // The points just entered — captured before mutating so `applyWriteResult`
        // can tell whether the slot moved on while the write was in flight.
        let points = games[index].points
        // The version the server already holds for this game (nil for a first
        // create) — carried through `.saving` so a failure re-derives the verb and
        // an in-flight clear knows whether a committed row exists.
        let committedVersion = Self.committedVersion(of: games[index].sync)
        games[index].sync = .saving(committedVersion: committedVersion)

        Task {
            do {
                let result: Result<Int, GameScoreConflictDTO>
                switch intent {
                case .create:
                    result = try await service.createGameScore(
                        matchId: matchId, gameNumber: gameNumber,
                        game: points, yourSideNumber: yourSideNumber
                    )
                case .update(let expectedVersion):
                    result = try await service.updateGameScore(
                        matchId: matchId, gameNumber: gameNumber,
                        game: points, expectedVersion: expectedVersion,
                        yourSideNumber: yourSideNumber
                    )
                }
                applyWriteResult(gameNumber: gameNumber, sent: points, outcome: .completed(result))
            } catch {
                applyWriteResult(gameNumber: gameNumber, sent: points, outcome: .threw)
            }
        }
    }

    /// The version the server holds for a slot in this sync state, or nil when no
    /// committed row exists yet — the token a retry/update or an in-flight clear
    /// needs. `.saving`/`.failed` carry the pre-write version; `.saved`/`.conflict`
    /// carry the current one; `.localOnly` has none.
    private static func committedVersion(of sync: SyncState) -> Int? {
        switch sync {
        case .localOnly: return nil
        case .saving(let v), .failed(let v): return v
        case .saved(let v), .conflict(_, let v): return v
        }
    }

    /// Reduce one write's result into the addressed slot, keyed by GAME NUMBER
    /// (not a captured array index) since the user may have moved on.
    ///
    /// - A slot cleared while this write was in flight resolves the deferred
    ///   DELETE here (see `pendingClearDeletes`): now that the write settled, a
    ///   row may exist, so fire the DELETE and drop the result.
    /// - Otherwise the transition applies only while the slot is still the
    ///   `.saving` we set for THIS write (a clear that moved it off `.saving`
    ///   already handled the server). Only one write is ever in flight per slot
    ///   (`.saving` maps to a nil intent), so a live `.saving` is always ours.
    ///
    /// Transitions:
    /// - success(version): `.saved(version:)`. If the user *edited* the game while
    ///   the write was in flight, the server now holds the stale points, so re-fire
    ///   to overwrite them at the fresh version rather than stranding the edit.
    /// - 409 with a committed score → `.conflict`, the committed points re-oriented
    ///   from canonical side-1/side-2 onto the viewer's `a` = you / `b` = them axis
    ///   (the same `mineIsSide1` rule the read path uses).
    /// - 409 without a committed score (shouldn't happen) / thrown error →
    ///   `.failed(committedVersion:)`, preserving the pre-write version so a retry
    ///   re-fires the correct verb.
    @MainActor
    private func applyWriteResult(gameNumber: Int, sent: Game, outcome: WriteOutcome) {
        // Deferred clear: the slot was cleared while this create was in flight.
        // The write has now settled, so fire the DELETE (best-effort — a 404 means
        // the write never landed) and consume the entry without touching the slot,
        // which the user already reset locally. (Edge: if the create 409'd because
        // another participant scored this game, the DELETE removes their score —
        // permitted under the shared-board model, and only reachable via a
        // clear-during-a-concurrent-create race.)
        if pendingClearDeletes.remove(gameNumber) != nil {
            if let matchId {
                Task { try? await service.deleteGameScore(matchId: matchId, gameNumber: gameNumber) }
            }
            return
        }

        let index = gameNumber - 1
        guard games.indices.contains(index) else { return }
        guard case .saving(let committedVersion) = games[index].sync else { return }

        switch outcome {
        case .completed(.success(let version)):
            games[index].sync = .saved(version: version)
            if games[index].points != sent {
                // The user edited this game while the write was in flight, so the
                // server now holds `sent`, not what's on screen. Re-fire: with the
                // slot at `.saved(version)`, `fireWrite` derives an update at the
                // fresh version and persists the current points.
                fireWrite(for: index)
            }
        case .completed(.failure(let conflict)):
            if let committed = conflict.committedScore {
                let oriented = MatchService.orientedGame(
                    side1: committed.side1Points, side2: committed.side2Points,
                    mineIsSide1: yourSideNumber != 2
                )
                games[index].sync = .conflict(committed: oriented, version: committed.version)
                // If the conflict landed on the game the user is still looking at,
                // prompt the decision immediately; otherwise the chip's warn
                // triangle flags it and tapping it opens the same dialog.
                if index == active { resolving = index }
            } else {
                games[index].sync = .failed(committedVersion: committedVersion)
            }
        case .threw:
            games[index].sync = .failed(committedVersion: committedVersion)
        }
    }

    // MARK: Conflict resolution (keep-committed vs use-mine)

    /// The committed server points and version for the game currently being
    /// resolved, if any — drives the conflict dialog's copy and its keep action.
    /// `committed` is already on the viewer's `a` = you / `b` = them axis.
    private var resolvingConflict: (committed: Game, version: Int)? {
        guard let i = resolving, games.indices.contains(i),
              case let .conflict(committed, version) = games[i].sync else { return nil }
        return (committed, version)
    }

    /// "Keep their score": adopt the server's committed points for game `i`, mark
    /// the slot saved at the conflict's version, and clear the conflict. Fires NO
    /// write — we're accepting what the server already holds. Mirrors web's
    /// keepCommittedScore. Re-seeds the raw fields when the game is active so the
    /// inputs show the adopted score.
    private func keepCommitted(_ i: Int, committed: Game, version: Int) {
        guard games.indices.contains(i) else { return }
        games[i].points = committed
        games[i].sync = .saved(version: version)
        resolving = nil
        if i == active { syncRawFromActive() }
    }

    /// "Use my score": keep the slot's current entry and re-fire the write. The
    /// slot is still `.conflict(_, v)`, so `fireWrite` re-derives an
    /// `.update(expectedVersion: v)` and PUTs with the fresh version — a
    /// deliberate overwrite, not a blind last-write-wins. Mirrors web's
    /// overwriteWithMyScore; delegates to the existing write path rather than
    /// duplicating it.
    private func useMyScore(_ i: Int) {
        resolving = nil
        fireWrite(for: i)
    }

    /// A game's points as a compact "you–them" scoreline for the conflict copy.
    private func scoreText(_ g: Game) -> String {
        "\(g.a.map(String.init) ?? "?")–\(g.b.map(String.init) ?? "?")"
    }

    private func post() {
        // The clean decided board: the completed games in play order, game 1 up to
        // and including the decider. `decidedGames` returns nil for an overrun (a
        // completed slot past the decider) — so an overrun board is *refused* here,
        // not silently truncated, matching the server's finalize rules and the web
        // client. The coordinator posts these to `POST /v1/matches/{id}/results`;
        // the server computes sets won, the winner, and any rating change — not us.
        guard let finalGames = MatchRules.decidedGames(games.map(\.points), bestOf: config.bestOf) else { return }
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
    /// The slot's scratchpad sync status, surfaced as a tiny corner indicator so
    /// the user sees each game's save progress (saving → saved) or trouble
    /// (failed / conflict) without leaving the scoreline — mirrors web's
    /// per-cell status dot.
    let sync: SyncState
    let active: Bool
    /// True for an empty slot past the decider: the match is already decided, so
    /// entering it would overrun. Rendered dimmer and made untappable — but only
    /// empty slots are locked, so an overrun game stays selectable to be cleared.
    let locked: Bool
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
            .opacity(locked ? 0.32 : (!done && !active ? 0.5 : 1))
            // Sync status rides in the top-trailing corner as an overlay so it
            // never widens the chip — a full best-of-7 row still shares the width
            // evenly. `.localOnly` shows nothing (looks like today's board).
            .overlay(alignment: .topTrailing) {
                syncIndicator
                    .padding(2)
            }
        }
        .buttonStyle(.plain)
        // Any scored game can be selected and edited in any order; the slot that's
        // already active is inert, as is an empty slot locked past the decider.
        .disabled(active || locked)
    }

    /// Tiny, unobtrusive glyph reflecting the slot's scratchpad sync: a spinner
    /// while saving, a subtle success check once saved, and a warning mark on
    /// failure — with conflict distinguished from a plain failure by hue (amber
    /// `warn` vs red `loss`). Resolving a conflict is a later task; this only
    /// flags it.
    @ViewBuilder
    private var syncIndicator: some View {
        switch sync {
        case .localOnly:
            EmptyView()
        case .saving:
            ProgressView()
                .controlSize(.mini)
                .tint(FMColor.fgMuted)
                .scaleEffect(0.7)
        case .saved:
            Image(systemName: "checkmark")
                .font(.system(size: 7, weight: .bold))
                .foregroundStyle(FMColor.serve500)
        case .failed:
            Image(systemName: "exclamationmark.circle.fill")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(FMColor.loss)
        case .conflict:
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 8, weight: .bold))
                .foregroundStyle(FMColor.warn)
        }
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
