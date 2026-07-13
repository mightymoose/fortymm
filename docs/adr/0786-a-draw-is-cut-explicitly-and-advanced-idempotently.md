# 786. A draw is cut explicitly and advanced idempotently

Date: 2026-07-12 (numbered by issue #786 — sequential numbers collide across
concurrent worktrees, as the duplicate 0008s in this directory attest)

## Status

Accepted — design for slices B/C of epic #780 (#785, #786, #788, #789), decided
before implementation.

## Context

`DrawType` (single-elim / double-elim / round-robin / rr-then-ko / swiss) has
been persisted since epic #595 and nothing consumes it. The B/C slices of epic
#780 as originally written sketch an **event-driven, persist-once** model: B1
generates a bracket with a stored `next_slot_id` per slot, C1 creates a real
match when both sides of a slot are known, and C2 "propagates the winner to
`next_slot_id`" when a result lands — per-draw-type advancement code hanging
off match completion.

The A slices are shipped and give us hard invariants to build on: registration
is only open while `published`, go-live row-locks the tournament so no entry
can land after it commits (#782), and there is a single lifecycle dispatch
point (`LEGAL_TRANSITIONS`, ADR-0017) that explicitly reserved a home for a
go-live precondition.

Two facts complicated the issue text as written:

- **Pools are venue value-objects, not rows.** `TournamentEvent.pools` is JSONB
  (`{id, name, slot, table_ids}` — a slice of tables for a window of time),
  wholesale-replaced by `PATCH`. There is nothing for a bracket row to foreign-key.
- **There is no "the player's rating" to seed from.** Ratings are league-scoped
  (`UserLeagueRating`) and tournaments are deliberately standalone, so B1's
  "fallback: rating, then random-by-index" is unimplementable as written — and
  randomness would break re-cut determinism besides.

## Decision

### Persisted fixtures are the truth once cut; strategies are pure planners

A **fixture** (see `CONTEXT.md`) is one planned pairing of a draw: a round and
position (plus a pool, when pooled), sides nullable while unknown. One table,
`tournament_fixtures`, holds every draw type's fixtures, identified by
`UNIQUE (event_id, pool_id, round, position)`.

Each `DrawType` is a strategy behind a `Protocol` with two pure operations:

- `plan_initial(config, ordered_entrants) → [PlannedFixture]` — cuts the draw.
- `advance(fixtures) → AdvancePlan` — reads the persisted state and returns
  side-fills for TBD fixtures plus the fixtures now ready to materialize.
  **Idempotent**: against an unchanged state it returns an empty plan, so it is
  re-run after *every* result (and at go-live) rather than triggered by
  carefully-chosen events.

  Idempotence forces the definition of **ready**: both sides known **and** not
  already materialized (`match_id is None`) **and** not already decided
  (`winner_entry_id is None`). Ready cannot mean merely "both sides known", or
  every run would re-propose the whole event's matches forever. The
  already-decided clause also stops a fixture whose match row was unlinked
  (`match_id` is `ON DELETE SET NULL`) from rising from the dead.

Two alternatives were rejected:

- **Full replan** (recompute the whole draw from live entries at each step) —
  a withdrawal mid-pool would redistribute entrants who already have results.
  Placement is frozen at the cut; the only sanctioned full replan is an
  explicit re-cut.
- **Event-driven pointer-chasing** (C2's "propagate winner to `next_slot_id`")
  — that is per-type advancement code at every result site, and it cannot
  express swiss at all (the next round *does not exist* until the previous one
  completes; only an `advance()` that may create fixtures can model it).

### The schema stores less than the issues asked for

- **No `next_slot_id`.** Topology is the strategy's knowledge: single-elim's
  successor is arithmetic on `(round, position)`; round-robin has none; swiss
  computes pairings. Storing it is a second copy that churns on re-cut.
- **`NULL` side means exactly "TBD — `advance()` will fill it".** Byes are
  modeled as *absence*: a byed seed simply has no round-1 fixture and is placed
  directly into round 2; an odd round-robin pool just has fewer fixtures per
  round. No `is_bye` flag, no NULL-means-two-things.
- **No entrant↔pool assignment table.** Pool membership is derived from the
  fixtures themselves (same argument as ADR-0016's derived `entered` count).
- **`pool_id` is a string ref, not a FK.** It names a `Pool` value-object in
  the event's own JSONB — consistent with how pools already reference tables.
  Integrity is procedural, not schematic: **the pool id set freezes while a
  draw exists** (the pools `PATCH` keeps wholesale-replace but must preserve
  the id set), while a pool's *venue attributes* (`table_ids`, its window)
  stay editable mid-event, because venues change under running tournaments.
  Promoting pools to rows is the known remedy if this guard ever leaks.

For B3: rr-then-ko needs no new columns (pool fixtures carry a `pool_id`, KO
fixtures carry `NULL`); double-elim will add a bracket/stage discriminator when
it lands (pre-deploy, the migration is edited in place).

### A draw is cut explicitly, gated by play — never by status

`POST …/events/{event_id}/draw` (owner-only) cuts or re-cuts; `DELETE` un-cuts
(and un-freezes the pool set). Both are refused only on **evidence of play**:
any decided fixture, any linked match with a game on its scratchpad or a result
proposed. Status-gating was rejected — it would forbid the legitimate day-of
move (no-show before the first ball: withdraw, re-cut) while protecting
nothing the play-guard doesn't. Note the guard is deliberately *stricter* than
issue #785's "refuse if matches already played": a mere scratchpad game blocks
re-cutting, because the draw must never silently eat entered scores.

Go-live was deliberately **not** made to auto-cut missing draws: cutting is a
reviewable act (the director inspects pools/seeding and re-cuts *before*
committing), and a status transition that fans out into N generations has N
confusing ways to fail.

### Go-live requires every draw to exist and be *current*; matches materialize only in `live`

Registration stays open while `published`, so a draw can be **stale** by
go-live — cut before the last entrant arrived. The `published → live` edge
therefore validates, inside the existing go-live row-lock, that the tournament
has **at least one event** and that every event's draw exists **and** its
fixtures cover exactly the event's active entrants, 409ing with the offending
events otherwise. This is the precondition ADR-0017 reserved space for. (The
≥1-event guard closes the hole the #782 hand-off flagged: with zero events the
per-event check is vacuously satisfied, and an empty tournament could go live.
Publishing an empty tournament stays legal — announcing early is fine; starting
nothing is not.)

Materialization (a fixture with both sides known becoming a real propose/accept
match, C1) is gated on the tournament being `live`, and **the go-live
transition runs the first `advance()`** as its final act. Cut while published →
fixtures only, previewable and re-cuttable; go live → every ready fixture
becomes a real match in one stroke (for round-robin, the entire event). "Create
matches as early as possible" — so the table scheduler (D1) sees the full
field of work — thus means *the first second of `live`*, and never earlier:
players must not receive playable matches while registration is still open.
The scheduler plans on **fixtures**, which exist pre-live.

### An account merge that double-counted a human invalidates the draw

A guest and the claimed account they merge into may *both* be actively entered
in the same event. `merge_user` already resolves that collision by hard-deleting
the guest's duplicate entry — which, with the fixtures table's `ON DELETE
CASCADE`, would silently punch holes in a cut draw.

The tempting repair — **re-point the guest's fixtures onto the surviving
entry** — is wrong, and dangerously so. It seats one human in two slots of the
same pool (everyone else plays them twice; drawn against themselves, the fixture
is self-play), and because the go-live currency check compares entrant *sets*,
the corrupted draw would **satisfy the check and go live**. The cascade's holes
are the safer failure: they make the sets differ, and go-live refuses.

So a merge collision **un-cuts the event's draw** (deletes its fixtures) and the
director re-cuts. A draw cut from a field that double-counted a human is wrong
throughout — its pool sizes and snake seeding were computed against N+1
entrants — so it is regenerated, never patched. The merge itself is never
refused (consistent with the self-play collision doctrine). The surviving entry
inherits the **earlier** `created_at` and any seed, because registration order
is the draw's ordering tie-break and must not shift silently.

A merge collision on an event whose play has already begun cannot be resolved
this way (the play guard forbids un-cutting) and is left for #788, where matches
exist and the self-play-collision machinery — transfer then void — applies.
Until then it is unreachable: no tournament match exists to have been played.

### Entrants are ordered by seed, then registration order

`plan_initial` receives an already-ordered list: `seed` ascending where set,
then `created_at` (registration order) for the unseeded rest. Deterministic
(idempotent re-cuts, testable), domain-local (no reach into league ratings).
Nothing sets `seed` today; a director-only seed-assignment endpoint is a
deliberately separate slice, and until it lands draws are seeded by
registration order — which is what club-night reality does anyway.

### #786 carries the substrate; #785 shrinks to a strategy

Reversing the epic's B1→B2 order: round-robin exercises strictly more of the
substrate (pool refs, the freeze, multi-pool distribution, a real if trivial
`advance`). #786 ships the migration, model, `draws.py` (protocol + registry +
`RoundRobinStrategy`), both draw endpoints, the freeze and currency guards, the
detail-BFF growth and the Events-tab pools scaffold. #785 becomes
`SingleElimStrategy` + bracket rendering, touching the registry's exhaustive
`match` and nothing structural.

## Consequences

- C2's advancement is "write `winner_entry_id`, run `advance()`" — one
  mechanism for every draw type, no per-type code at result sites.
- Fixtures appear on the wire inside the existing tournament-detail BFF (each
  event gains its draw), preserving the one-endpoint-per-page rule; the only
  new routes are the two draw mutations.
- A 5-entrant single-elim persists 4 rows; the 8-slot visual bracket frame and
  "bye" labels are derived at render time from the fixtures' shape.
- The registry's exhaustive `match` on `DrawType` makes each B3 format a type
  error until implemented; unimplemented types 422 at the draw endpoint.
- Pool standings (C2) are a read-model over decided fixtures — deliberately
  *not* a strategy method. Swiss will need standings internally for pairing;
  when it lands, its strategy computes what it needs without widening the
  shared interface.
