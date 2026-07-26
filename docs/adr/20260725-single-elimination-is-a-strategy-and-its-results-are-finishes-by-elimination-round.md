# 785. Single-elimination is a strategy, and its results are finishes by elimination round

Date: 2026-07-25 (numbered by issue #785 — sequential numbers collide across
concurrent worktrees; see ADR-0786's note and the duplicate 0008s in this
directory)

## Status

Accepted — design for slice B1 of epic #780 (#785), decided before
implementation. Fills in the two seams ADR-0786 and ADR-0788 explicitly parked
for "when #785 lands": `SingleElimStrategy` (the first strategy whose `advance()`
seats a winner forward) and `SingleElimResults` (the first non-round-robin
results shape).

## Context

ADR-0786 laid the draw substrate — persisted `tournament_fixtures`, a pure
`DrawStrategy` per draw type (`plan_initial` + idempotent `advance`), byes as the
*absence* of a fixture, successor topology as "arithmetic on `(round, position)`"
the strategy owns rather than a stored `next_slot_id`. ADR-0788 laid the play
substrate — go-live materializes every *ready* fixture into a real match, a
single synchronous `on_match_completed` seam (wired at both the rated and unrated
completion sites) writes `winner_entry_id` and re-runs `advance()`, and an
event's **results** are a *separate* per-draw-type family (`results_for`) so that
`standings()` is not forced onto bracket draws.

Both ADRs shipped **round-robin only** and named single-elimination as the thing
that would exercise the parts round-robin never does: round-robin's `advance()`
fills **no** sides (every pairing is known at the cut), so `AdvancePlan.side_fills`
has never been non-empty, and `materialize_event` consumes only
`ready_fixture_ids` — it has never had to *apply* a side-fill. `results_for`
raises `UnsupportedResultsType` for single-elim, so a live single-elim event's
results read would crash. This ADR pins what those missing arms are.

Everything generic is already in place and draw-type-agnostic: go-live
materialization, the completion seam at both sites, the go-live currency
precondition (fixtures cover exactly the active entrants), and the
refuse-non-singles-at-cut guard. They will drive a `SingleElimStrategy`
end-to-end the moment it and the side-fill application exist.

## Decision

### The bracket is cut by standard recursive seeding; byes are absence

`plan_initial` receives entrants already ordered by seed-then-registration
(ADR-0786). It pads to `B = 2^k ≥ N` and lays them into the bracket by the
**standard recursive seeding table** (`[1,2] → [1,4,3,2] → [1,8,5,4,3,6,7,2] →
…`), so the top seed can only meet the second seed in the final, the 3/4 seeds in
the semifinals, and so on — a pure, unit-tested helper over seed *positions*.

The `B − N` byes fall on the top `B − N` seeds, for free: a bye is a round-1 slot
paired against a phantom seed past `N`. A byed seed has **no round-1 fixture**
(byes are absence, ADR-0786) and is seated **directly onto its round-2 fixture's
side** at cut time. Three round-2 shapes therefore exist at the cut:

- both feeders played → both sides `NULL` (TBD, filled by `advance()`),
- one bye + one played feeder → one side pre-filled, one `NULL`,
- both feeders byes → both sides pre-filled (a fully-known fixture, materialized
  at go-live like any other via the existing `ready_fixtures()`).

`plan_initial` never emits a fixture for a bye and never sets an `is_bye` flag —
consistent with the fixture model's "NULL means exactly TBD" contract.

### `advance()` seats the winner forward — the first non-empty `side_fills`

A decided fixture at `(round r, position p)` feeds `(r+1, ceil(p/2))`, side `a`
if `p` is odd else side `b`. `SingleElimStrategy.advance()` returns those
`SideFill`s for every decided-but-not-yet-propagated fixture, plus the fixtures
that are now ready. It stays **idempotent** by the ADR-0786 definition of ready
(both sides known, `match_id is None`, `winner_entry_id is None`): a side already
filled is not re-filled, a match already created is not re-proposed. The final
round has no successor; its `winner_entry_id` is the **champion**, read through
the results, never stored as a crown.

`materialize_event` learns to **apply `plan.side_fills`** (persist the seated
winners onto their TBD fixtures) *before* the readiness pass, so a fixture made
whole by this result materializes into a real match in the same completion
transaction. This is the side-fill application ADR-0788 deferred here; no other
wiring changes — the completion seam and go-live path already call `advance()`.

### An event whose bracket cannot be cut is refused at the cut

`plan_initial` refuses `N < 2` with `DegenerateDraw` (a one-entrant bracket has
no fixtures — a config a director reached by mistake), mirroring round-robin's
per-pool floor. The earliest failure is the clearest one (ADR-0786), and it keeps
the go-live currency check and results path from ever reasoning about an event
with zero fixtures.

### Results are *finishes*: placement by elimination round, ties honest

`SingleElimResults` (a new `results_for` arm) computes an event's **finishes**:
each entrant's finishing position, derived **live** from completed fixtures by the
round it was eliminated in — champion (1st), runner-up (2nd), the semifinal
losers tied 3rd, the quarterfinal losers tied 5th, and so on. **Same-round losers
tie**: single-elimination genuinely does not rank them against each other, so a
shared position is honest — inventing a tiebreak (seed, game-difference) would
fabricate an ordering the format never produced. Champion is simply finish
position 1. Nothing is snapshotted, so a **correction** or **voided match**
re-derives the finishes (and can re-crown) with no extra hook — the same property
ADR-0788 established for standings.

### Results cross the wire as a discriminated union tagged by shape

`results_for`'s return type widens (as ADR-0788 foresaw) into a **union tagged by
shape**: `{kind: "standings", …}` for round-robin, `{kind: "finishes", …}` for
single-elimination. Coercing finishes into the `standings` row shape was
rejected: a bracket has no wins/game-difference/head-to-head columns, so every
such row would carry meaningless nullable fields — the tri-state smell
`api/CLAUDE.md` warns against. Each results strategy returns its own shape; the
BFF emits the tag; the client switches on `kind` (standings table vs. finishes
list). The union member is exhaustive-`match`ed like `results_for` itself, so a
future draw type is a type error until it declares its shape.

### The bracket renders as rounds-as-columns; connectors are deferred

The frontend replaces the flat `RoundList` placeholder for `state.unpooled` with
a **columnar bracket**: one column per round left-to-right, each fixture a card
showing both sides (seed + name), byes implied by a seed already sitting in a
later column, the champion highlighted. It renders **pre-live too** (a cut,
not-yet-live draw shows the seeded round-1 pairings and byes for the director to
review before go-live). **Elbow/SVG connector geometry is deferred** to a
follow-up: the columns already communicate the bracket unambiguously (round
headers + seed numbers), the layout stays mobile-friendly by scrolling
horizontally, and it is cleanly page-object/vitest-testable, whereas connector
geometry is high-effort polish that adds no information and fights responsive
widths.

## Consequences

- `AdvancePlan.side_fills` becomes load-bearing for the first time; the
  round-robin "honestly empty" seam ADR-0788 described now does real work for
  single-elimination through the *same* call.
- There are now two implemented arms in each of the two exhaustive strategy
  registries (`strategy_for`, `results_for`); double-elim / swiss / rr-then-ko
  stay type errors until implemented, unchanged.
- A single-elimination tournament is playable end-to-end — cut → review →
  go-live materializes round 1 (and any all-bye round-2 fixtures) → each result
  seats the winner forward and materializes the next match → the final crowns a
  champion — with **no new completion-site code**.
- The results block on the tournament-detail BFF gains a second render path
  (finishes), keyed by the `kind` tag; the one-endpoint-per-page rule holds.
- Connector geometry and director-assigned seeding remain explicit follow-ups,
  not oversights.
- iOS is untouched beyond the generated-types drift guard (`Types.swift`
  regenerates from the widened results schema); no native bracket UI this slice.
