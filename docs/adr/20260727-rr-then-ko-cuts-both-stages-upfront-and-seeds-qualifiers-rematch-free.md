# rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free

Date: 2026-07-27 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted — decided before implementation, for issue #1227 (split out of #787).
Builds on ADR 20260726 ("a draw type is a seeded row, and the enum holds only
what runs"), whose closing paragraph predicted this ticket would be "a seeded
row, an enum member, a strategy, a results strategy, and a settings variant,
and the client needs no change." Two of those claims turn out to be wrong; see
Context.

## Context

`rr-then-ko` runs round-robin pools, then seeds a single-elimination knockout
from the pool finishers — top *K* from each pool advance. #1219 deleted the
member from `DrawType`, so the format is currently unconstructible, and #1227
re-adds it on top of the substrate #1219 landed.

Two premises inherited from the prior ADRs did not survive checking.

**"The client needs no change" is false, and fails silently.** The draw-type
picker does render the served catalogue, but
`web-client/src/components/tournaments/data/draw-types.ts:29` holds `DRAW_TYPES`,
a hardcoded slug allowlist, and the catalogue parser's transform *filters out*
any served key not in it. Seeding an `rr-then-ko` row therefore makes the type
appear in OpenAPI and **vanish from the picker** — no error, no warning, just an
absent option. At least three client edits are required, only one of which
(`planDraw`'s exhaustive `switch` in the MSW factory) is a compile error.

**The settings discriminated union does not exist.** ADR 20260726's companion
describes settings as "a Pydantic discriminated union tagged by the slug over
`RoundRobinSettings | SingleElimSettings`". Those classes were never written —
`tournament_event_draw_settings` holds only `draw_type_key`. This ticket
*creates* the union rather than appending to it, and it is the first
draw-type-conditional control in the event editor: there is no per-draw-type
settings UI anywhere today, and `PoolsSection` does not so much as mention
`drawType`.

Three facts about the existing code shaped the decisions below.

**`_seed_slots` pairs seed `s` with seed `B+1−s` in round one.** The function's
recursion maintains that adjacent slots sum to `2·len + 1`; its own docstring's
worked 16-slot example (`1,16,9,8,5,12,13,4,…`) has every pair summing to 17.
This collapses "seed the qualifiers into the bracket" from a bracket-layout
problem to a much smaller one: choosing which qualifier gets which seed *number*.

**`advance()` cannot see game counts.** Its whole input is `Sequence[FixtureState]`,
which carries `winner_entry_id` but no per-side games, so it can compute wins and
head-to-head but neither of the two game tiebreakers a pool's finishing order
falls through to. And `app.results` already imports `app.draws`, so the obvious
fix — have the strategy call `RoundRobinResults` — is an import cycle.

**The schedule preview refuses per *tournament*, not per event.** The exhaustive
`match` at `app/schedule_preview.py:260` sits inside the per-event loop of a
whole-tournament builder, so a single un-schedulable event aborts the preview for
every event beside it. That refusal was written when the only un-pooled type was
single-elim, where the *entire* event is un-schedulable; the reasoning does not
transfer to a format whose pool stage schedules perfectly well.

## Decision

**Both stages are cut in one stroke, and the knockout bracket is cut upfront with
TBD sides.** `plan_initial` emits the pool fixtures *and* the full bracket. This
was pre-committed by ADR-0786's `AdvancePlan`, which can express only `SideFill`
(fill a side of an *existing* fixture) plus `ready_fixture_ids` — there is
deliberately no way for `advance()` to create a fixture, and giving it one is a
far wider blast radius than a new strategy. The cost is nil: the qualifier count
is `P × K`, known at cut time, so the bracket size `next_power_of_two(P × K)` is
deterministic. Bracket size is **derived, never configured** — carrying both
lets them contradict (`api/CLAUDE.md`, "don't carry a field and its own
derivation in the same model").

**No new fixture columns.** `pool_id IS NULL` is the knockout stage, exactly as
ADR-0786 pre-committed and as four places already encode.

**The legal configuration space** is: `K ≥ 1` enforced by Pydantic at the request
boundary (static); `P × K ≥ 2` and `K ≤ ⌊N/P⌋` enforced at the cut as
`DegenerateDraw` (both depend on the entrant count, which moves). This mirrors
the split `_snake` already uses for its own pool floor. A **one-pool**
rr-then-ko is legal — it is "league, then a playoff", a real format — and so is
`K = ⌊N/P⌋`, where everyone qualifies and the pool stage exists purely to seed.

**Round-one knockout fixtures never pair two entrants from the same pool, for
`P ≥ 2`, and the guarantee is absolute rather than best-effort.** Qualifiers are
ordered **place-major** — every pool winner outranks every runner-up — and the
*pool order within a place* is chosen to avoid conflicts. Three facts make this
provable rather than hopeful:

- a place block holds each pool exactly once, so an **intra-block** round-one
  pair is safe automatically;
- round-one pairing is a perfect matching on seeds, so each seed has **at most
  one** partner and therefore at most **one forbidden pool**;
- assigning blocks in order, every position then allows at least `P−1` pools, so
  Hall's condition holds for any set `S` of positions with `|S| ≤ P−1`
  (`|N(S)| ≥ P−1 ≥ |S|`). The remaining case, `|S| = P`, is the one that needs
  the block's *geometry* rather than a counting argument, and the first draft of
  this ADR got it wrong: "each position forbids only one pool" does **not** by
  itself reach every pool, because `|N(S)|` collapses to `P−1` precisely when all
  `P` positions forbid the *same* pool. What rules that out is that a block is
  `P` **consecutive** seeds and round one pairs `s ↔ B+1−s`, which is
  order-reversing — so a block's partners are themselves a run of `P` consecutive
  seeds, spanning at most two blocks, and each block hands each pool to exactly
  one seed. At most **two** of a block's positions can therefore forbid the same
  pool, which is fewer than `P` for `P ≥ 3`. `P = 2` is the only size where two
  would suffice, and there the partner run is `{B−2b−1, B−2b}`, whose lower
  member is odd because `B` is a power of two — so both partners sit in the *same*
  block and hold *different* pools.

  A conflict-free assignment therefore always exists, and a deterministic pass
  (pools tried in ascending order, augmenting when stuck) finds it. Probed over
  `P` 2..64 × `K` 1..40, the largest number of one block's positions forbidding a
  single pool is **1**, so the bound proved here is conservative.

We rejected the two fixed orderings the issue floated. Ordering by place-then-pool
pairs `C1` against `C2` at three pools; reversing the runners-up fixes three pools
and breaks two. Neither can be universal, because *which* pairs are cross-block
depends on `B − Q`, which jumps around with `P`. A rule that adapts per block is
the only kind that can be.

`_seed_slots` is **reused unchanged** — it supplies the bracket's shape, and this
decision only chooses seed numbers.

**Within a finishing place, pools are not ranked against each other.** Every pool
winner is an equal. This is the same stance `FinishRow` already takes on
same-round losers: inventing a cross-pool tiebreak would fabricate an order the
format never produced. It is also precisely what leaves the permutation free for
the guarantee above.

**With one pool the guarantee is waived, not broken.** Every qualifier shares a
pool, so every knockout match is a rematch. That is the format working as
intended.

**Qualifiers are seated per-pool, as each pool finishes.** The seed → (pool,
place) map depends only on `P`, `K` and `B`, so it is fully determined at cut
time and is independent of results. A pool's qualifiers therefore go into their
predetermined slots the moment *that* pool is decided, with other pools still
playing; the knockout fixture simply is not `ready` until both its sides are
seated, which `ready_fixtures` already handles. `advance()` stays idempotent
because `SideFill` only ever fills an empty side.

**A correction that changes who qualified does not re-seat the bracket**, and we
ship that knowingly. Because `SideFill` only fills an *empty* side, a pool match
corrected after its pool's qualifiers were seated leaves the original qualifier
in the bracket while the standings re-order beneath them. Single-elimination
already behaves this way — a corrected result never un-seats a winner — so this
is not a new class of behaviour, but rr-then-ko makes it far easier to reach:
pool corrections are ordinary, and the window between a pool finishing and its
qualifiers playing out is long.

We considered re-seating while the knockout stage is untouched (allowed only
before any KO match has materialized) and rejected it for now as new state to
reason about for a case that has not yet been observed; and refusing the
correction outright, which makes a genuine scoring error uncorrectable — much
worse than the disagreement it prevents. If this bites in practice, the
untouched-bracket re-seat is the option to reach for.

**The seeded row's director-facing copy** is `Round-robin then knockout` /
`Pools play all-play-all, then the top finishers from each pool meet in a
knockout bracket.` Recorded here because `draw_types.name` and `.description`
are seed data, so changing them is a migration.

**The pool finishing order moves to a shared pure module that both `app.draws`
and `app.results` import.** The tiebreak chain is not reimplemented — it is the
existing one, relocated so both callers can reach it, which resolves the import
cycle. `RoundRobinResults` keeps being the standings strategy and calls it for
its table; the rr-then-ko strategy calls the same function to take the top *K*.
The claim this protects is that **the qualifiers are exactly the top *K* of the
standings table the tournament is reading** — structurally, not by two
implementations agreeing.

`FixtureState` gains the games each side won, which is unavoidable if
qualification is to match the displayed standings, and lets qualification derive
from the same live-outcome view the standings use rather than the written-back
`winner_entry_id` that no read reads. We rejected giving rr-then-ko a *reduced*
tiebreak chain (wins → head-to-head → entry id) that `FixtureState` already
supports: it is nearly free and silently disagrees with the standings on screen,
at the exact moment — a three-way tie for the last qualifying spot — when a
director is looking hardest.

**Knockout rounds restart at 1.** The unique constraint is
`(event_id, pool_id, round, position)` declared `NULLS NOT DISTINCT`, so the
knockout stage has its own numbering namespace. Continuing from the pool rounds
was rejected as *ill-defined*, not merely ugly: pool rounds run `1..seats−1`, and
`_snake` lets pools within one event differ in size, so there is no single "last
pool round" to offset from — and even taking the maximum, "the semifinal" would
be round 5 in one event and round 7 in another. Restarting also means the
knockout maths transfers unchanged (`_successor`, and `SingleElimResults`'
`2 ** (final_round − round) + 1`), and the client's bracket — which names rounds
relative to the maximum round it is handed, and is handed only the un-pooled
fixtures — produces "Final / Semifinals / Quarterfinals" with no change at all.

`_round_label` widens to take the fixture's `pool_id`, since `pool_id IS NULL`
is already the stage discriminator, and reuses the two existing arms' vocabulary
verbatim: pooled → `"Group match N"`, un-pooled → `"Round N"`.

**Results are a third arm of the wire union, tagged `standings_then_finishes`,**
carrying one standings block and one finishes block. Restructuring the union into
a composite was rejected: it would change how the existing two arms are read,
forcing client changes for round-robin and single-elim that buy nothing. **The
champion comes from the bracket** — never from a pool — and `complete` is both
stages decided.

**The schedule preview previews the pool stage and skips the knockout stage,**
rather than refusing the whole tournament. In the *live* solver this already
happens for free: `schedule_solves.py` skips un-pooled fixtures and TBD-sided
ones independently, so an rr-then-ko event's pools schedule today with no new
code. Only the preview needs a filter. Scheduling the knockout stage is **#1228**,
deliberately out of scope — a freshly cut bracket is entirely TBD-sided, so
knockout scheduling is inherently *incremental* (placeable only as pools resolve),
which is a different solver contract rather than a bigger one.

**A voided pool pairing is left out of the "pool is finished" test, not counted as
a missing score.** A voided match is terminal and never produces a result. The
standings already take this position: `PoolInput.fixture_count` counts only the
pairings that can still yield a result, so a pool that hit one still reaches
`complete`. The draw side must agree, because the qualifiers are meant to be the
top of the table a director is reading. If it counted the voided pairing instead,
the pool would sit one score short forever. Its qualifiers would never seat, the
knockout would never become ready, and no director action could clear it, while
the table on screen called that same pool complete. Two layers would disagree
about the one fact they exist to share.

The voided pairing's **entrants** still count as seated in the pool. A player
whose only pairing was voided appears in the finishing order with a row of zeros,
which is what the standings table shows.

**A pool with no usable result at all is refused, not served.** When every pairing
in a pool is voided, the only thing left to rank on is the entry-id fallback at
the end of the tiebreak chain, so the qualifiers would be arbitrary. This is the
one place the two layers part company on purpose. The standings call such a pool
complete and show a table of zeros, which is honest to look at. Seating
qualifiers off it would not be. Voiding has exactly one producer today, an
account merge's self-play collision (ADR-0013), so reaching this needs every
pairing in one pool to be voided.

Nothing re-advances a draw at void time. `account_merge` calls `void_match` and
never `materialize_event`, so the seating catches up on the next result
completion in that event. If the voided pairing is the last thing outstanding in
the whole event, no further completion happens and those qualifiers stay
unseated. Making the void path re-advance the event would close that gap.

## Consequences

The client is not free, and one of its failure modes is silent. `DRAW_TYPES` must
gain the slug or the picker quietly omits the format. `planDraw`'s exhaustive
`switch` and `ResultsPanel`'s `never` arm *are* compile errors and will catch
themselves; `parseResults` will not — it **throws** on an unknown `kind`, which
fails the whole tournament-detail query rather than degrading one panel. **Server
and client must therefore land in the same PR**, or the app breaks for every
tournament, not just rr-then-ko ones.

`StandingsPanel` and `FinishesPanel` cannot be reused as they stand: each takes
the `event` and internally bails unless `results.kind` matches its own, so
rendering both means refactoring them to accept their data as props.

The MSW store does not derive results at all — every seeded event hardcodes its
`results` block and `cutDraw` never touches it — so exercising the new shape in
dev and vitest means hand-seeding a two-stage fixture.

`FixtureState` gaining game counts touches the projection in
`app.tournament_draws` and adds a query at the materialization seam. The two
strategies that do not care ignore the new fields.

The "a multi-pool round-robin has no champion" carve-out in `EventResults` and
`StandingsResultsRead` stays **true** and keeps its meaning; only its
parenthetical — that a pools-then-knockout draw type "does not exist yet" —
goes stale. Editing it as though the claim itself had changed would introduce a
bug.

`_stage_label` needs an arm, and "complete" is ambiguous for a two-stage event.
It stays minimal (`"Complete"` / `"In play"`); naming which stage is live needs
more plumbing than this ticket should buy.

Every draw type still reaching an exhaustive `match` means the four dispatch
sites (`strategy_for`, `results_for`, `schedule_preview`, `dashboard_tournaments`)
fail to type-check until all are handled — which is the property ADR 20260726
bought, working as designed.
