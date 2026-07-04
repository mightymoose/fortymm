# Every finalize surface reconstructs the full board, never a subset

When a match becomes decided, more than one client surface can offer the
one-tap finalize ("Post result" / "Finalize result"): `score-entry.tsx`'s main
submit button (on the game whose entry screen is mounted) and
`save-banner.tsx`'s failed-save banner (which can be showing while the user
sits on a *different* game's screen). Each one independently reconstructs the
candidate **decided board** (ADR 0002) client-side, because the authoritative
board only exists as scattered optimistic state until the result is posted. The
decision recorded here: **whichever surface offers finalize must reconstruct the
board from *all* of the sources below — it may not silently omit a game that
lives only in a source that surface doesn't happen to read.**

The three sources of a game's newest score, highest precedence first:

1. **The active game's live typed input** — the RHF field values on the entry
   screen currently mounted. Newest of all, but only exists in that component's
   local state (not in any cache), so only `score-entry` can read it.
2. **Failed scratch saves** — per-game saves that never reached the server,
   held in the shared mutation cache (`useFailedGameSaves`). Newer than the
   persisted score for the same game (it's what the scoreline cell shows).
3. **Persisted scratchpad games** — the committed per-game scores from the
   match payload.

For any game number, precedence is `live input > failed scratch > persisted`.

## Two surfaces, two half-reconstructions

Neither surface reads all three sources directly, and that is fine *as long as
it doesn't drop a game the other would count*:

- `score-entry` reads **live input (active game) + persisted**. It owns the
  active game's live value and hands the banner off for it (see the banner's
  `decidedHere` / `wouldFinalize` split — when the active game's own score is
  the sole decider, the banner goes informational and the main button posts the
  live inputs).
- `save-banner` reads **persisted + failed scratch**. It deliberately does *not*
  read live inputs (it may be on another game's screen), deferring the active
  game's live value back to `score-entry`'s button via `decidedHere`.

The bug in each case is the same shape: a surface offering finalize dropped a
source it *should* have folded in.

## Bug context

- **#755** — `save-banner` excluded the active game from its persisted loop
  unconditionally, relying on the failed-scratch loop to re-add it. That loop
  only fires when the active game *failed* to save. So a **cleanly-persisted
  active game** (has a committed score, no failed save) fell out of the merged
  board, making the match read as not-decided and **hiding the finalize CTA**
  behind an unrelated failed game's retry. No corruption — a hidden shortcut.
  Fixed by including the active game's persisted score in the merged board
  (source 3 for the active game was being dropped).

- **#747 F2** — `score-entry` ignores **failed scratch saves** on non-active
  games (it builds its board from persisted + live input only). A failed
  non-active game therefore compacts out (ADR 0002), so "Post result" records
  e.g. a 2–1 board as 2–0 — it **erases a game**. Data corruption, the opposite
  symptom, in the opposite file. Fix pending: `score-entry` must fold source 2
  (failed scratch saves) into its board the way `save-banner` already does.

Same contract violated from both ends. #755's half is fixed here; #747 F2's half
is tracked on that issue. Once both land, both surfaces reconstruct a board that
covers all three sources and can never hide a real finalize nor mint a board
missing a played game.

## Rejected (for now): one shared reconstruction helper

The obvious end-state is a single `reconstructDecidedBoard()` both surfaces
call, instead of two hand-rolled merges that drift. Deferred because the active
game's live input lives only in `score-entry`'s RHF state and would have to be
threaded into a shared helper (the banner has no access to it), making the
shared-helper change materially larger than the two targeted source fixes. Both
issues are fixed by adding the missing source to each existing merge; the
unification can follow once both sides read the same three sources.
