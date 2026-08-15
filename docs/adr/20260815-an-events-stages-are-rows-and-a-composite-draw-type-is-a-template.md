# An event's stages are rows, and a composite draw type is a template

Date: 2026-08-15 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during the design pass for #1348, a follow-up to #1338.
Supersedes one part of ADR 20260726 ("a draw type is a seeded row"): the slug
stops being the primary key of `draw_types`. Everything else in that ADR
stands. The stage-column rejection in ADR 20260807's alternatives was scoped
to scheduling and is not contradicted here.

## Context

A fixture's stage is not stored. Readers derive it from two facts: the event's
draw type names the shape, and `pool_id IS NULL` marks the un-pooled stage.
About twenty sites re-derive this, across the API, the solver, and the web
client.

The derivation needs both facts because `pool_id IS NULL` is ambiguous on its
own. A swiss round and a knockout round are indistinguishable at the row
level. That ambiguity already shipped a bug: swiss fixtures once rendered as a
knockout bracket (`web-client/src/components/tournaments/data/draw.ts:147`).

Only one draw type is multi-stage. Round robin, single elimination, and swiss
are one stage each. rr-then-ko is a pool stage feeding a knockout stage. So
the model must keep the single-stage case trivial.

The sport's regulations use this vocabulary. ITTF events play a "group stage"
and then a "knock-out stage", and multi-part formats number them as first and
second stages. `CONTEXT.md` already picked **Stage** and avoids "phase".

Two open issues want an anchor a derived stage cannot give them. #1316 wants
the knockout confined to chosen tables and a chosen day. #1338 splits the
competitive group from the venue reservation, and a group needs a stage to
belong to.

## Decision

**1. A stage is a row the event owns.**

```sql
tournament_event_stages (
  id            uuid PRIMARY KEY,
  event_id      uuid NOT NULL REFERENCES tournament_events (id) ON DELETE CASCADE,
  position      int  NOT NULL,
  draw_type_id  uuid NOT NULL REFERENCES draw_types (id) ON DELETE RESTRICT,
  UNIQUE (event_id, id),
  UNIQUE (event_id, position)
)
```

`UNIQUE (event_id, id)` exists purely as a composite-FK target, as on pools.

**2. `draw_types` gains a surrogate `id` primary key.** The slug `key` becomes
a `UNIQUE` column. Code still resolves strategies by `key`. The database joins
on `id`, so `tournament_event_draw_settings.draw_type_key` migrates to
`draw_type_id`. This supersedes the slug-as-PK stance of ADR 20260726.

**3. The system mints stages from a template in code. A director never authors
them.** The template maps each event-level draw type to a stage sequence:
`round_robin → [round_robin]`, `single_elim → [single_elim]`,
`swiss → [swiss]`, `rr_then_ko → [round_robin, single_elim]`. Stages are minted when the draw
settings are configured. On a draw-type change while no draw exists, the
template is re-applied in place: stage 1 keeps its identity and its draw type
is updated, and later stages are added or removed. A director's pools hang off
stage 1, so they survive a type change, as they do today. Stages freeze once a
draw exists. This is the same freeze rule pools have. A new draw shape adds a template entry, not a new derivation
rule.

**4. Compositeness lives in the strategy layer, not in a column.** There is no
"stage-runnable" flag on `draw_types`. The code knows `rr_then_ko` is a
template and refuses it as a stage's type at the boundary. This is the same
stance the enum takes: the seed set is exactly what runs.

**5. A fixture names its stage.** `tournament_fixtures.stage_id` is a
`NOT NULL` FK, and `event_id` is dropped from the fixture. The event is
reachable through the stage, and `ON DELETE CASCADE` flows event → stage →
fixture. The identity constraint becomes
`UNIQUE (stage_id, pool_id, round, position) NULLS NOT DISTINCT`. The knockout
stage's round numbering restarting at 1 now falls out of the key instead of
being a documented namespace rule.

**6. Each stage runs under the strategy its draw type names.**
`RrThenKoStrategy` dissolves. The pool stage runs `RoundRobinStrategy`, the
knockout stage runs `SingleElimStrategy`, and the composite's only remaining
job is the inter-stage seam. Both stages are still cut together in one stroke,
and `AdvancePlan` still cannot create a fixture. ADR-0786 and ADR 20260727
stand.

**7. Qualifier flow stays derived.** Stage `position` defines the feed: each
stage feeds the next. The seed → (pool, place) map stays a pure function,
recomputed on `advance()`, and "winner of Pool A" labels derive on read from
the same map. One repair rides along: the map labels pools by the director's
`position` order, not by sorted ids, so "Pool A" means the same pool
everywhere. The map stays a bijection, so the rematch-free guarantee of ADR
20260727 is unaffected.

**8. A stage means nothing to the scheduler, for now.** A pooled fixture is
confined to its pool. Every other fixture takes the event's window and the
tournament's tables, through the solver's synthetic event-wide reservation.
Stages carry no venue data. #1316 stays open and waits for the reservation
work that #1338 starts. A stage row is the anchor that work will attach to.

## Consequences

**Migrations may be rewritten in place.** As of this ADR no environment holds
data worth preserving, so the implementation is free to edit existing Alembic
revisions rather than append new ones, and no backfill is owed anywhere.

**The twenty derivation sites become reads.** The web client's
`unpooledShape(drawType)` switch and its warning comment go away: the stage's
draw type says whether an un-pooled block is a bracket or swiss rounds.

**Sequencing with #1338 is one seam.** Dropping `event_id` from fixtures
removes the column the pool composite FK uses today. The pool's group face
therefore re-parents to the stage, giving the fixture
`(stage_id, pool_id) → tournament_event_pools (stage_id, id)`. #1338 later
splits the reservation face back out. Both arcs should be planned against this one
target schema rather than migrating the same tables twice.

**The wire changes.** OpenAPI regen on both clients, and the fixture payloads
gain their stage. The dashboard's derived `stage_label` keeps working and can
later read the stage row.

**`draw_types.id` touches every reader of the seed table.** The picker, the
settings row, and both generated clients see the new column. Slug renames stop
being FK migrations, but stay code migrations, because the enum binds on `key`.

## Alternatives considered

**An enum column on the fixture.** Cheapest, but a stage is about to need
attachments (#1316 reservations, #1338 groups), and a per-fixture enum has
nowhere to hang them. It also repeats one fact on hundreds of rows.

**Composed events: rr-then-ko as two events, one feeding the next.** Reuses
the single-stage machinery, but an event is the unit of entry, results, and
champion. The knockout event would have no entrants until the pools finish,
the director would manage two events for one competition, and the qualifier
flow still needs an inter-event edge. Composition saves nothing it appears to
save.

**No rows: join to the draw type.** The template half of that instinct is
right and is kept (decision 3). But per-event things — fixtures, groups,
reservations — need a per-event FK target, and shared reference data cannot be
one. This is the same argument ADR 20260808 made for pools being rows.

**A parallel stage-kind enum (`group | knockout | swiss`).** Reinvents
`draw_types`. The stage kinds map one-to-one onto strategies that already
exist, so the stage references the registry instead.

**Persisting the qualifier seat map.** Hand-editable, but stored state that
can drift from the recompute, against ADR-0786's derive-don't-store stance.
Corrections already deliberately never re-seat, and stored seats make that
story murkier.

**Stage-attached reservations.** Deferred, not rejected. The reservation
model is #1338's design pass, and answering #1316 here would prejudge it.
