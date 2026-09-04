# The scratchpad is contiguous

Date: 2026-09-02
Status: accepted

Closes item 5 of #1661.

## Context

The per-game scratchpad accepted a score for any game number up to `best_of`, in any order,
and allowed any saved game to be cleared. `_overrun_decided_at` in `api/app/match_scoring.py`
documented this as deliberate: out-of-order entry was allowed until a side clinched before the
highest-numbered scored game.

A board with a gap has no single reading. The QA pass for #1661 cleared game 1 of a best-of-3
that already held game 2, and saved game 4 of a best-of-5 before games 2 and 3. The entry page
showed the gap. The opponent's match page showed the surviving score under a different game
number. Finalize compacted the board and renumbered the games again. Every screen told its own
story about the same match.

A table-tennis match plays its games in order. A gap is not a state the match can be in.

## Decision

The scratchpad refuses a write that would leave a gap, at the boundary, with a sentence that
names the game to deal with first:

- A save to game N requires a committed score on every game 1 to N-1. Otherwise the write is
  refused with `ScoreNotAllowedError` (422): "Save game K before game N.", where K is the first
  unsaved game.
- A clear of game N requires no committed score on any game after N. Otherwise the write is
  refused with `ScoreNotAllowedError` (422): "Clear game M first, or edit game N instead.",
  where M is the highest saved game.

Both guards run inside the same locked write path as the existing range and no-overrun guards,
in `enter_game_score` and `delete_game_score`. `update_game_score` is unaffected: editing a
saved game in place leaves the board's shape alone.

The web client mirrors the guards before the player types. The entry screen for a game past
the next unsaved one shows the boundary refusal with the same sentence, and the scoreline
offers a clear only on the last saved game.

## Consequences

- Every surface numbers a match's games the same way, because the board can only ever be
  games 1 to N with no holes. `compact_games` at finalize becomes a no-op on any board the
  scratchpad produced. It stays, because a client may still post a board it composed itself.
- A cleared game reads as cleared everywhere. Only the last game can be cleared, so clearing
  never renumbers anything.
- A player who wants to change an earlier game edits it instead of clearing it. The refusal
  says so.
- The scoreline's "Game N, not yet played" links past the next game no longer lead to a form
  the save would refuse.
