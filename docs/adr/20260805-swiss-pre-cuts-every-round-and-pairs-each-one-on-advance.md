# Swiss pre-cuts every round and pairs each one on advance

Date: 2026-08-05

## Status

Accepted

## Context

A draw is cut explicitly, and `advance()` is re-run after every result (ADR-0786).
`plan_initial` returns the complete set of fixtures. `advance()` returns
`side_fills` and `ready_fixture_ids`. It cannot create a fixture.

Swiss appears to break that model. Round 3 pairs players by their standings after
round 2, so who meets whom is unknown when the draw is cut. `api/app/draws.py`
says as much in its own module docstring: "a swiss draw could not know its next
round until the current one finished."

The obvious reading is that `advance()` must grow the power to create fixtures.
That reading is wrong, and two facts in this codebase are why.

**Single-elimination already pre-cuts rounds whose sides are unknown.** A side is
`None` "only when it is genuinely TBD (single-elim's later rounds)". The whole
bracket is written at the cut, and `advance()` fills the later rounds in as
results arrive. A fixture row with two unknown sides is an ordinary, already
supported state.

**The field is frozen once the tournament is live.** Withdrawing an active entry
is refused outside the registration window
(`_enforce_withdrawal_registration_open`).

**Correction, 2026-08-06.** This section originally drew a second conclusion from
that: "so the entrant count `n` cannot move after the cut". **That is wrong.**
Cutting a draw has no status gate, so a draw is cut while the tournament is still
`published` and registration is still open. The field can move between the cut and
go-live — which is exactly why this arc needed a chore to stop an odd swiss field
reading as stale, and why an existing test is named
`test_a_swap_between_the_cut_and_go_live_is_stale`.

The decision below is unaffected, and it is worth being precise about why. The
fixture count follows from the field the cut *actually saw*, not from a promise
that the field will not move. A field that moves under a cut draw makes the draw
**stale**, which go-live already refuses. So the count is determined at the cut,
and the model holds — it just holds for a narrower reason than first written.

With the field the cut saw and the round count `R` known, every swiss round holds
exactly `floor(n / 2)` fixtures. Only the *sides* are unknown, which is the one
thing this model already handles.

## Decision

### `plan_initial` cuts all `R` rounds, with sides unknown past round 1

Swiss writes `R * floor(n / 2)` fixtures at the cut. Round 1 has both sides set,
seeded from the draw order. Every later round is written with `entry_a_id` and
`entry_b_id` NULL.

NULL keeps meaning exactly what it means everywhere else: TBD, and `advance()`
will fill it. No new meaning is added, and no `is_bye` style flag appears.

### `advance()` pairs a round once the previous round is decided

When every fixture in round `r` has a completed match, `advance()` computes the
standings, pairs the field for round `r + 1`, and returns ordinary `SideFill`s
against that round's already-written rows.

This needs **no change to `AdvancePlan`** and no amendment to ADR-0786. The draw
is still cut exactly once, explicitly. Filling a known-empty side is what
`advance()` has always done.

Idempotency holds for the same reason it holds for single-elim. Once a round's
sides are filled, a re-run finds nothing to fill and returns an empty plan.

`advance()` only ever fills a side that is NULL. It never rewrites one. So a
correction to an earlier round's result does not re-pair a round that is already
paired and possibly played.

### A fixture's `position` is its pairing rank within the round

Position 1 is the pairing containing the highest-ranked player, position 2 the
next, and so on. `position` is assigned when the round is paired.

In single-elim `(round, position)` is a topology and `_successor` does arithmetic
on it. Swiss has no successor arithmetic, so position could have been an arbitrary
allocation. Defining it as pairing rank instead keeps
`UNIQUE (event_id, pool_id, round, position)` a real identity, and makes the draw
read top-down in standings order.

### The round count `R` is a required, explicit setting

Swiss stores `{"rounds": R}` in the draw settings JSON object. It is required.
There is no derived default.

`R` is not computed from the entrant count, even though `ceil(log2(n))` is the
conventional answer. A director books tables and a venue window before
registration opens. A derived `R` would move as entrants arrive, changing the
length of a day that is already booked. The schedule preview also has to answer
"how long is this day" before anyone has registered, and an explicit `R` is what
lets it answer honestly.

`R > n - 1 + n % 2` is refused at the cut as `DegenerateDraw`. The ceiling is the
number of rounds the field can play with nobody meeting twice, and that number
depends on the parity of `n`. An even field plays `n - 1` rounds: everybody plays
every round, so the ceiling is the count of distinct opponents. An odd field plays
`n`, because each round byes exactly one entrant, so over `n` rounds every entrant
plays `n - 1` matches and sits out once. This is refused at the cut rather than at
configure time, because `n` is not known when the setting is written.

This rule first shipped as `R > n - 1` for every field, justified by the
distinct-opponent count alone. That justification was off by one for an odd field,
and the rule **refused a legal draw**: a 5-entrant event could not play 5 rounds,
which is a rematch-free swiss and the fullest one that field can play.

**The bound is necessary, not sufficient.** Below it a rematch-free pairing
exists, but the greedy walk does not always find one. Five entrants over four
rounds repeat a pairing in round 3, while `1-4` and `5-2` was available. Finding
the rematch-free pairing in every case is a maximum-weight matching problem, and
this draw layer is deliberately pure and deterministic, with no solver. We accept
the occasional avoidable rematch rather than give a pure domain a solver
dependency, and rather than refuse to pair, which would strand a live event.

### A round's capacity is `floor(active field / 2)`, and rows beyond it are unpairable

Added 2026-08-06, after code review found two bugs that share this root.

Pre-cutting fixes each round's row count at the cut, as `cut_size // 2`. The
**active field can still shrink afterwards.** Cutting has no status gate, and
`account_merge` withdraws a colliding entry on a live, played event — it withdraws
rather than deletes precisely because the row seats played fixtures. So a guest
playing in a live swiss draw who claims a verified account already entered in that
event drops the field by one.

When that happens the pre-written rows outnumber the pairings the field can make.
So a round's **capacity** is `floor(len(active field) / 2)`, and a round is fully
paired when its filled rows reach that capacity — not when every written row is
filled. Rows beyond capacity are **permanently unpairable**, not pending.

That distinction has to hold in three places or the problem only moves: the pairing
gate, decidedness, and the completeness count. Miss the second and an unpairable
row holds its round open forever. Miss the third and the event can never read
complete.

**The two bugs this fixes, neither of which anything pinned.** Requiring every row
filled meant a shrunk field left rows NULL, after which the round was neither
wholly unpaired nor decided and the draw **stopped pairing forever** — with no
operator recourse, since a played draw cannot be un-cut. Separately, the results
layer derived byes from the active entrants *unioned with every seated entry*, so a
departed entrant read as byed in every later round and collected a win for each
one.

The union itself is right and stays: a player who actually played keeps a row in
the table. Only the **bye derivation** narrows to the active field, so both layers
pair and score from one field.

The reverse case is unchanged and still correct: a field that *grew* by one has one
more pairing than rows, and that pairing is dropped.

**One claim this overturned.** `_swiss_bye`'s fallback — take the lowest-ranked
entrant once everybody has had a bye — was documented as unreachable, on the
grounds that a legal cut has fewer rounds than entrants. Under a shrunk field it is
reachable: six entrants cut for five rounds, three left after round 1, and by round
5 nobody is byeless. It is now pinned by a test driven through real cuts and
advances rather than asserted to be impossible.

## Consequences

Swiss costs no change to `AdvancePlan` and no migration beyond the settings object
it shares with every other draw type.

**Correction, 2026-08-05.** This section first claimed swiss cost *no change to the
strategy contract*. That turned out to be wrong, and the reason is worth keeping.
`advance()` now takes the ordered field as well as the fixtures.

The fixtures cannot name the field. A byed entrant sits in no fixture row, by
definition. So does a latecomer who joined a draw cut for an even field, because
`floor(8/2)` and `floor(9/2)` are the same four fixtures. Pairing from the seated
set therefore byes the same entrant every round and never pairs the latecomer at
all. Only the entrants know who is playing.

The claim was right about `AdvancePlan`, which is the part that mattered: swiss
still fills existing rows and creates none, so the draw is still cut exactly once
and ADR-0786 stands. But the contract did move, and a reader trusting the original
sentence would have been misled.

The scheduler needs no change either. It already asserts both sides are known and
its caller already drops fixtures that do not qualify, so an unpaired later round
is skipped until it is filled.

**The schedule preview refuses swiss**, exactly as it refuses single-elim. The
preview covers the pool stage, and a pool-less draw type raises
`UnsupportedDrawType` rather than returning a preview that silently covers
nothing. Swiss is pool-less, so it takes the same path. A director previewing a
swiss event is told the format has no preview, instead of being shown an empty
day.

**An unplayed swiss round is visible as empty fixtures.** A director looking at a
5-round draw sees rounds 2 to 5 as rows with no players. This is the same thing a
single-elim bracket already shows for its later rounds, so it is consistent, but
swiss shows more of it.

**A stalled round stalls the whole event.** Round `r + 1` cannot pair until every
match in round `r` is complete. One unreported result blocks the rest of the
field. Single-elim has no equivalent, because there only the two players feeding a
given fixture can block it.
