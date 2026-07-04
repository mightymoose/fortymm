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

- **#747 F2** — `score-entry` ignored **failed scratch saves** on non-active
  games (it built its board from persisted + live input only). A failed
  non-active game therefore compacted out (ADR 0002), so "Post result" recorded
  e.g. a 2–1 board as 2–0 — it **erased a game**. Data corruption, the opposite
  symptom, in the opposite file. Fixed by routing `score-entry`'s board through
  the shared `reconstructBoard` helper below, which folds in source 2.

Same contract was violated from both ends. Both halves are now fixed: both
surfaces reconstruct a board that covers all three sources and can never hide a
real finalize nor mint a board missing a played game.

## Why F2 could only be fixed client-side (two boundaries, not one)

F2 looks like a sibling of the first-post board-conflict guard (ADR 0003 / issue
#747-B2), and both are about *not posting a board that isn't the true board* —
but they are **complementary guards at two different boundaries**, not one fix:

- **B2 is server-side.** On first propose the server value-compares the proposed
  board against the games another participant **committed** to the scratchpad and
  409s on divergence (`_scratchpad_divergence`, `matches.py`). It works precisely
  because the diverging game *reached the server*.
- **F2 can never be caught server-side.** The dropped game is a *failed* scratch
  save — it **never reached the server**, so there is nothing for the propose
  endpoint to compare against or "keep." The endpoint faithfully validates and
  mints exactly the board it is handed (`_validate_finalize_games` +
  `_commit_canonical_games`, "the list is canon, no merge"); a board missing G2
  is a clean, decided board it cannot object to. The failed G2 exists **only** in
  the client's mutation cache, so the reconstruction has to happen in the client
  before the payload is sent.

So "propose validates the whole match" does not rescue F2: the client must
assemble the true board from all local sources (this ADR), *and* the server
rejects committed-divergence (ADR 0003). Different files, different failure
modes, both required.

## Adopted: one shared `reconstructBoard` helper

Both surfaces now call a single `reconstructBoard` helper
(`web-client/src/components/matches/reconstruct-board.ts`) instead of
hand-rolling two merges that drift — that drift was the shared root cause of
*both* #755 and #747 F2. The module lives beside its two callers (not in the
framework-pure `@/lib/scoring`) because it is app-aware, and it owns **both**
app-shape → board mappings so neither caller hand-rolls either one:

- `scoredGamePoints(games)` — the persisted `data.games` → `GamePoints[]`
  mapping, exported and called by both surfaces (and by `score-entry` for its
  `decider`), so the persisted mapping has one source.
- the `FailedGameSave.variables` → `GamePoints` mapping, inside
  `reconstructBoard`.

Shape:

```ts
reconstructBoard({
  persisted,                 // GamePoints[] (via scoredGamePoints)
  failedSaves,               // FailedGameSave[]; caller passes conflicts already excluded
  activeInput?,              // GamePoints; score-entry only, only when inputsValid
}): GamePoints[]             // raw merged board — the CALLER compacts
```

Design points that fell out of the interview:

- **Overlay order `persisted → failed → activeInput`.** The last write wins per
  game number, so `activeInput` (passed only by `score-entry`) naturally beats a
  same-game failed scratch, giving exactly the source precedence `live > failed >
  persisted`. Callers therefore need not pre-filter the active game out of
  `failedSaves`.
- **Callers exclude conflicts**, not the helper. A conflicted failed save's
  committed value is already in `persisted`; folding the *rejected* scratch would
  re-introduce the data-loss overwrite the version guard prevents. `save-banner`
  already filters `!entry.conflict` at the call site — `score-entry` does the
  same. The helper stays a pure board-merge with no conflict opinion.
- **The helper returns the raw merged board; the caller compacts.**
  `score-entry` needs the un-compacted board for `overrunDecider` (which reports
  the true game number), and both callers already own their `compactGames` call.

The earlier objection — "the active game's live input lives only in
`score-entry`'s RHF state" — is answered by making `activeInput` an *optional
parameter*: `score-entry` passes it, `save-banner` passes none (it defers the
active game's live value to `score-entry`'s button via `decidedHere`, unchanged).

## Known limitation: the scoreline `decider` stays persisted-only

The fix reconstructs only the **finalize board** (`hypotheticalGames` →
`wouldFinalize`/`overrunDecider`/posted payload). `score-entry`'s other
persisted-only read — `decider` (lines ~212–213), which gates scoreline cell
muting and the out-of-range nav bounce — is deliberately **left unchanged**. So a
failed save that would itself clinch the match (e.g. G1 persisted, G2 *failed*,
both wins in a best-of-3) does not mute the trailing cells. This is not a
corruption path: the **save-banner** reads persisted ⊕ failed, sees the decided
board, and surfaces "These scores finish the match — Post result." Folding failed
(unsaved, possibly mid-retry) scratch data into `decider` would change muting
behavior with its own edge cases, beyond F2's blast radius; scoped out, revisit
if it becomes a real confusion.
