# A correction is a full board re-score, not a per-cell edit

When a participant corrects a standing result, the correction surface lets them
re-score the **whole decided board** — adding, removing, and changing games up to
`best_of` — seeded from the standing result. The only constraint is that what they
send is again a *decided board* (enforced client-side by `decidedSide` and
server-side by the propose endpoint's 422 gate).

We rejected the simpler "edit the existing game scores only" model because a
correction frequently changes the *number* of games: if a game was recorded with
the wrong winner (e.g. a 3–0 that was really 2–1), flipping it leaves the board
undecided, and without the ability to add the deciding game(s) the match would be
**stuck** with no legal result reachable. Allowing add/remove is the only model
that lets every real correction reach a decided result.

Consequence: the correction page mirrors the score-entry page's board editor
(all `best_of` slots, add via empty slot, clear via ✕, running games tally) rather
than a fixed list of pre-filled inputs — but it backs the edits with a local,
unsaved buffer and submits the whole board as a single `propose`, because the
scratchpad is frozen once a result stands.
