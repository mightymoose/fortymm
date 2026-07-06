# iOS scores through the shared scratchpad, not a local board

Until now the iOS score-entry flow held every entered game in SwiftUI `@State`
(`ScoreEntryView.games`) and wrote nothing until the whole match was committed
via `POST /matches/{id}/results`. Web, by contrast, saves **each game** to the
shared server-side **scratchpad** as it is entered (`POST/PUT/DELETE
.../games/{n}/scores`). The consequences on iOS: backing out or an app kill
mid-match discarded every unposted game, and the board a spectator or the
opponent fetched stayed empty until the final post. (Finding D6.)

We decided iOS must reach **write-path parity** with web: score entry writes to
the shared scratchpad per game. The shared scratchpad is a **product
requirement**, not a web implementation detail — it is what makes a match's
board authoritative server-side so spectators can see it. (See `CONTEXT.md` —
**Scratchpad**, **Spectator**, **Live spectating**.)

## What "parity" means here — the resolved decisions

- **Write granularity mirrors web.** A game is written when the user taps *Save
  game & next* (`POST .../scores/new`), re-written when they edit an
  already-saved game (`PUT .../scores` with `expected_version`), and deleted
  when they clear one (`DELETE .../scores`). The un-tapped digits of the game
  being typed stay local, exactly as web's unsaved input does. `POST /results`
  (finalize) is unchanged.
- **Clearing a saved game now needs a confirm dialog** (web gates `DELETE`
  behind one, #387) — clearing destroys a *shared committed* game, not just
  local state.
- **Writes are optimistic and fire-and-forget.** The UI advances to the next
  game immediately in the same gesture; the write runs in a detached `Task`.
  Each scoreline chip reflects per-game sync state (**saving → saved →
  failed/conflict**). Chosen over synchronous blocking writes so the
  keyboard-driven entry flow is not gated on a network round-trip between every
  game.
- **A per-game sync-state model carries what the writes need.** Each slot
  becomes a `ScoredGame { points; sync }` where
  `sync ∈ {localOnly, saving, saved(version), failed(retained), conflict(committed, version)}`.
  The endpoint choice *is* the sync state (`localOnly` → create, `saved` →
  versioned update), which also correctly routes an edit of a game the
  *opponent* saved. This requires threading `version` + `game_number` through
  the read path into `ResumeScoring.games` (widened from `[Game]`), where the
  server's `MatchScoreDTO.version` was previously decoded and dropped.
- **Conflicts resolve per-chip, mirroring web.** A 409 (create-collision, or
  stale `expected_version`) arrives after the user may have advanced, so it
  attaches to *that game's* chip. Tapping it offers **Keep committed** vs **Use
  mine** (the overwrite re-fires with the fresh version from the 409 body). The
  final `POST /results` still runs `_scratchpad_divergence` (ADR 0003), so an
  unresolved conflict can never corrupt the minted result — the per-chip UI is
  about graceful resolution, not last-resort correctness.

## Rejected alternative: keep iOS local-only and rely on the post-time guard

iOS already gets *board-level* conflict protection for free: `POST /results`
409s via `_scratchpad_divergence` if its board diverges from what's committed.
So the finding's claim that iOS "bypasses all the web conflict handling" is
inaccurate — it trades per-game merge for board-level reject-on-divergence.
Rejected as sufficient anyway: it leaves the server board empty mid-match, which
defeats the spectator requirement, and still loses every entered game on
back-out / app kill. Board-level protection guards *correctness*; it does not
make the board *visible*, which is the point.

## Rejected alternative: synchronous blocking writes

Awaiting each `POST .../scores/new` behind the existing `FMBlockingSpinner`
before advancing is simpler and reuses the current error-alert path, but puts a
full network round-trip between every game and hard-stops the user with an alert
on any transient failure. Rejected as hostile to the fast entry flow
`ScoreEntryView` is built around.

## Explicitly out of scope (filed separately)

These were considered and deliberately deferred so D6 stays "write-path parity":

- **Live spectating** — an open view auto-refreshing to show scratchpad changes
  without a reload. **Unbuilt on every platform** today (web polls only a
  posted-but-unaccepted result, never an in-progress scratchpad). It is a
  cross-platform product feature, not an iOS bug, and folding it in would hide
  that web needs the same work.
- **Offline queue** — web auto-retries failed writes when connectivity returns
  and defers finalize offline. iOS ships **manual-retry-only**: a failed write
  shows the chip as `failed` with points retained and a Retry affordance; no
  background queue, no offline finalize. The spectator goal is inherently
  online, so this has low payoff for D6.
- **Local durability** — snapshotting the in-progress board to
  disk/`@SceneStorage` so the *un-saved current game* and *failed saves*
  survive an app kill. Web has no equivalent (its mutation cache is in-memory).
  With per-game writes, every *saved* game already survives a kill (resume reads
  it from `match_games`), so the residual loss window is only the game being
  typed plus an unretried failure — the same window web has.

## Consequence

After this change, the "app kill discards every entered game" complaint is
substantially resolved by the writes alone: saved games are durable server-side
and re-seed on resume. The remaining loss window (un-tapped current game +
unretried failed save) matches web and is left to the deferred local-durability
work above.
