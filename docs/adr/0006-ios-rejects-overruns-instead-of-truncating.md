# iOS rejects an overrun board, it does not silently truncate it

Web and the API treat a game scored *past* the clinch — an **overrun** — as
illegal input: the score-entry page blocks the save (`overrunDecider` disables
Post with "the match is already decided at game N — clear the games after it"),
and `POST /results` 422s a board that extends past the deciding game. Compaction
only ever closes *empty* gaps; it never drops a genuinely-scored overrun game
(ADR 0002). iOS was the odd one out: `ScoreEntryView` let the user keep tapping
chips past the clinch, counted them into the VS tally (`setsWon` over every
slot), and on Post silently *truncated* the board to the games through the
decider (`gamesThroughDecider`). It **laundered** the exact illegal input 0002
is careful to keep rejecting — a 4–0/5–0/3–1 board posted as 3–0 with no warning
(finding D5).

We decided iOS must reach the same contract: an overrun is refused, not healed.
Concretely, mirroring web's `scoring.ts`:

- **The VS tally counts only through the decider.** `setsWon` stops at the
  clinch, so the displayed score is the decided score, not an inflated count of
  post-decider slots.
- **Forward-gating.** Once a side clinches, no next chip appears — the shared
  scratchpad can't accept a forward overrun game (and, post-D6, can't *write*
  one to the server board).
- **Overrun detection for the retroactive case.** Editing an earlier game to
  clinch sooner orphans later slots — an overrun forward-gating can't prevent
  (the iOS board is a dense positional slot array, so an overrun is a completed
  slot at an index *past* the decider). iOS gains mirrors of web's
  `deciderGameNumber` + `overrunDecider`. **The Post-disable falls out of the
  strict decided-board check** — an overrun board fails it (the decider isn't the
  last scored slot), exactly as web keeps `overrunDecider` *separate* from its
  disable. `overrunDecider` exists only to *select the inline message* ("the
  match is decided at game N — clear the games after it"), so the user knows
  what to fix; they clear the orphaned slots via the existing D6 confirm-clear
  (`deleteGameScore`). This is parity with the API's 422 — iOS refuses to mint an
  overrun rather than truncating it.
- **`gamesThroughDecider` truncation is removed** (both callers: the
  Post-appears gate and `post()`). A postable board is now exactly a clean
  decided board — the iOS mirror of `isDecidedMatch`: a gap already yielded `nil`
  under the old helper too, so no gappy-decided board regresses (iOS never
  posted one; it has no compaction, unlike web). Anything not cleanly decided is
  blocked upstream, so there is nothing left to truncate.

## Considered options

- **Block at entry (chosen).** Make the overrun *unrepresentable* on iOS —
  forward-gate new entry and detect+block the retroactive overrun — so the
  contract holds by construction, matching what a web user experiences.
- **Allow entry, reject at Post with a message.** Keep letting the user type
  past the decider but replace the silent truncation with a hard block + inline
  error. More faithful than truncation, but leaves a foot-gun on screen and
  writes overrun games to the shared scratchpad only to reject them later.
- **Keep truncation but warn.** Rejected — it still heals illegal input, which
  *is* the contract violation; a warning does not make laundering correct.

## Consequence

The cross-platform contract is uniform: a victor plus scored games past the
decider is an error on every surface, surfaced to the user to fix, never
silently rewritten. iOS carries its own `deciderGameNumber`/`overrunDecider`
mirrors alongside the existing `setsWon`, and the truncating
`gamesThroughDecider` is replaced by a strict decided-board predicate (the
`isDecidedMatch` mirror). Fixes D5.
