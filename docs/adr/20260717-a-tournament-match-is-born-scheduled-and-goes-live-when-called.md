# A tournament match is born scheduled and goes live when called

Date: 2026-07-17 (date-numbered — sequential numbers collide across concurrent
worktrees; see ADR-0788's note and the four duplicate 0915s in this directory)

## Status

Accepted — fix for issue #1073, decided before implementation. **Amends
ADR-0788**, which materialized every ready fixture into a match with `status =
in_progress`. That one line is what this ADR overturns; everything else 0788
decided (materialization at go-live, side-1←entry-a, the completion→advance
seam) stands.

## Context

ADR-0788 made a tournament match **born `in_progress`** at go-live
materialization, reasoning that "both players are known and committed; there is
no accept-to-*start* step." That is true of a *casual* match — two people agree
and play now — but a tournament match is not played on agreement, it is played
when the **schedule calls it to a table**. The scheduler apparatus that landed
after 0788 (`app.scheduling` CP-SAT solver, `app.schedule_solves`, the call
service `app.match_calls`, ADR "the schedule is solved; the call is pinned")
made the call an explicit, notified event: a fixture's `pinned_at` is set and
both entrants are told *match_called* when its start enters the call-ahead
window.

Born-`in_progress` collides with that. The dashboard attention panel and the
matches-list Attention tab both treat any `in_progress` match the caller hasn't
posted a result on as **actionable** (`_actionable_attention_filter` /
`list_attention_kind` → `score`). So the instant a draw is cut, every
materialized-but-uncalled fixture floods every entrant's dashboard with phantom
"score" rows: a 5-player round-robin puts **4** on each of the 5 players'
dashboards, for matches nobody has been called to play. `in_progress` was
overloaded to mean both "scheduled" and "live," and the two need to be distinct.

Three facts made the fix cheap:

- **`pending` was already the right word, and unassigned.** The enum has always
  carried `pending`; nothing ever set it (both the casual and tournament create
  paths wrote `in_progress`). It *already* maps to `Status.SCHEDULED` on the
  scoreboard and to the passive `waiting_others` attention bucket — the exact
  semantics an uncalled fixture wants.
- **The client was already built for it.** `match-list-status.ts` has a
  `scheduled` → "Up next" tab (`TAB_TO_API.scheduled = 'pending'`), a
  `pending → scheduled` tone, and a `status-tone-scheduled` style — all dead
  code, because no match was ever `pending`. The lifecycle this ADR completes is
  the one the UI already anticipated.
- **The call is a single, centralized, notified event.** Every pin writer
  (guarded solve-apply, pin tick, manual placement) funnels its "tell both
  entrants" through the call service under the tournament row lock, so a status
  flip can ride the same locked transaction as the notification.

## Decision

### A ready fixture materializes into a `pending` match

Go-live materialization creates the match with **`status = pending`** (not
`in_progress`). It is *scheduled*: known, committed, and waiting to be called.

### The forward transition is the call — "the players were told"

A match flips **`pending → in_progress` at the moment its entrants are told to
play** — the *match_called* signal (`call_notified_count` 0→1), keyed on **the
notification, not raw `pinned_at`**. A fixture can be *silently pinned* pre-live
(placement set while planning, nobody notified); such a match materializes
`pending` and stays `pending` until its call-ahead notify actually fires. The
flip happens in the same locked transaction as the notification, at every path
that tells the entrants: the guarded apply's call, the pin tick's call, the pin
tick's *notify-without-re-pin* (a silent pin gone imminent), and a live manual
placement.

### The reverse transition is a pristine un-call

If a called match is **un-called before anyone has played** — the director
un-places it, lifting the pin and sending *match_call_cancelled* — it reverts
**`in_progress → pending`**, but **only if the match is pristine** (no game
scores and no results). A match with any play stays `in_progress`; the play is
real and the players still owe a score. The broken-pin *void* path (an entrant
withdrew) needs no revert — that match is voided/deleted anyway.

### The schedule is authoritative: an uncalled match is not scorable

`pending` is **not scorable**. `_is_scorable` (the single source of truth behind
both the write-path guard and the `can_score` BFF flag) requires
`status == in_progress`, aligning it with `can_finalize`, which already did. You
cannot score a match the scheduler has not called to a table — out-of-band play
would corrupt the solver's table model (its in-progress proxy assumes a live
match occupies the table it was pinned to). A never-scheduled match becomes
playable the honest way: the director adds a table, which re-solves and calls
it.

### The attention surfaces need no change

Because a `pending` match is already excluded from the actionable buckets
(`_actionable_attention_filter` gates on `in_progress`; `list_attention_kind`
routes `pending → waiting_others`), the flood disappears with **no edit to
either attention twin**. An uncalled fixture folds into the dashboard's passive
"waiting" count and appears under the matches-list "Up next" tab — visible, not
actionable — until it is called.

## Consequences

- `in_progress` finally means one thing: **live** (called, or playing). The
  scheduler's in-progress proxy (`pin is not None AND status is in_progress`)
  becomes belt-and-suspenders — the two halves now move together.
- A **never-tables** tournament cannot play its matches until a table is added
  (which re-solves and calls). This is deliberate, not a regression to paper
  over: the schedule is authoritative. It is the one place born-`in_progress`
  behaved more permissively, and we are choosing schedule integrity over
  out-of-band play.
- **No migration.** No schema change (the column and the `pending` value both
  exist); the change is *what* materialization writes and *when* the call flips
  it. Existing `in_progress`-but-uncalled matches do not retro-heal — fortymm is
  undeployed, so UAT is wiped/re-seeded rather than backfilled.
- Web/iOS are **verification, not new code**: the web "Up next"/scheduled
  treatment already exists; `pending` has always been a valid decoded enum value
  on iOS. Both need confirming against a real `pending` match, not building.
