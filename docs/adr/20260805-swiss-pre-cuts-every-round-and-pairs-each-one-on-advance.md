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
(`_enforce_withdrawal_registration_open`). So the entrant count `n` cannot move
after the cut.

Those two together remove the reason to change the strategy contract. With `n`
frozen and the round count `R` known, every swiss round holds exactly
`floor(n / 2)` fixtures. The fixture set is fully determined at the cut. Only the
*sides* are unknown, which is the one thing this model already handles.

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

`R > n - 1` is refused at the cut as `DegenerateDraw`. With `n` entrants a player
has at most `n - 1` distinct opponents, so beyond that a rematch-free swiss cannot
exist. This is refused at the cut rather than at configure time, because `n` is
not known when the setting is written.

## Consequences

Swiss costs no change to the strategy contract, no change to `AdvancePlan`, and no
migration beyond the settings object it shares with every other draw type.

The scheduler needs no change either. It already asserts both sides are known and
its caller already drops fixtures that do not qualify, so an unpaired later round
is skipped until it is filled.

**An unplayed swiss round is visible as empty fixtures.** A director looking at a
5-round draw sees rounds 2 to 5 as rows with no players. This is the same thing a
single-elim bracket already shows for its later rounds, so it is consistent, but
swiss shows more of it.

**A stalled round stalls the whole event.** Round `r + 1` cannot pair until every
match in round `r` is complete. One unreported result blocks the rest of the
field. Single-elim has no equivalent, because there only the two players feeding a
given fixture can block it.
