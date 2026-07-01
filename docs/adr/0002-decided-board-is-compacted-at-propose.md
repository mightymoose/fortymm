# A decided board is compacted at propose, not gap-locked at entry

When a side has clinched (some side reached `ceil(best_of/2)` game wins), the
board it is minted from is first **compacted**: the scored games are sorted and
renumbered `1..N` with any empty slots dropped. The scratchpad stays permissive
— every blank game cell is tappable while no side has clinched — so a user can
score out of order (jump to game 5 with game 4 still blank) and clinch there;
compaction turns the resulting gappy board `[1,2,3,5]` into the canonical
`[1,2,3,4]` that gets validated, committed, and frozen into the immutable result
snapshot.

This is provably safe: an empty slot contributes 0 wins to either side, so
compaction can never change the winner or the game score — only cosmetic slot
numbers. It also auto-corrects the originating mis-tap (the stray "game 5"
becomes game 4, exactly what in-order entry produces), so finalize is silent: no
note, no confirm, nothing to consent to.

Compaction closes only *empty* holes. A real **overrun** — a game genuinely
scored *past* the clinch, e.g. a fully-scored `[1,2,3,4,5]` where side 1 already
won at game 4 — has no empty slot to drop, so it compacts to itself and stays
**rejected** by the unchanged strict validator (`_validate_finalize_games` /
`matchScoreSchema`): "scored games extend past the deciding game." One operation
thus handles both cases correctly — heal the gap, keep blocking the overrun.

We keep the validators strict and apply compaction *upstream* at the callers,
rather than loosening the validators to tolerate gaps. Two crisp concepts stay
separate: a *canonical decided board* (strict — is this a clean `1..N` board
with the decider last?) versus *normalizing a gappy scratchpad into one*
(compaction). The correction surface (ADR 0001) keeps the strict checker
untouched — a gap there is a clear disabled-Send, not a dead-end.

Compaction is applied in both server spots — the write path (`post_match_result`
compacts `payload.games` upstream of validation, commit, and the snapshot) and
`_can_finalize` (via `_games_payload_from_match`). The latter is what
**incidentally heals already-stuck matches**: once `_can_finalize` compacts, any
gappy-but-decided saved board reports `can_finalize = true`, so the SaveBanner
offers "Post result" and the user self-heals with one tap — no migration, no
heal-banner. The front-end mirrors both (`compactGames` in `scoring.ts`, applied
in `score-entry.tsx`'s `wouldFinalize`/finalize payload and in the SaveBanner's
merged board) so the optimistic board matches what the server mints.

## Rejected alternative: frontier-lock the scoreline (block the gap at entry)

We considered making the scoreline refuse the out-of-order tap in the first
place — locking every game cell past the lowest unscored "frontier" so a user
could never score game 5 while game 4 is blank. Rejected in favor of
**allow-and-heal**:

- The jump-ahead is harmless once compaction exists — the clinch finalizes
  immediately and self-heals, so there is nothing to prevent.
- Frontier-locking is a larger, more intrusive diff on the entry UX (new gating
  state, new muted/blocked affordances) for a case the mint path already
  neutralizes.
- It would not heal the matches *already* stuck from the pre-fix behavior;
  `_can_finalize` compaction does, with no migration.

Allow-and-heal shrinks the change to `compactGames` + the `wouldFinalize`
predicate + the server seam + these docs, and leaves the scoreline gating alone.

## Bug context

Fixes #742: an out-of-order clinch produced a gappy decided board that read
"4–0" but could not finalize (a decided board was additionally required to be
contiguous `1..N`), while #741 correctly refused every score in the empty gap
game — a dead-end stuck at "4–0 · Live." Compaction closes the gap between *"has
a victor"* and *"is a mintable canonical board"*, restoring the stated §1
invariant that a match can never get stuck.
