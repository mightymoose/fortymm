# A pool belongs to its event, not to the event's draw settings

Date: 2026-08-01 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. **Amends the table sketch in "An event's draw configuration is a row,
not a column"** (2026-07-26), which placed `tournament_event_pools` under
`draw_settings_id`. That ADR's substance — draw configuration is a row, the enum
holds only what runs, per-type and per-event data are different tables — is
unaffected. Decided during the grill for #1226.

## Context

The 2026-07-26 ADR scoped a follow-on ticket to normalize pools and tables, and
sketched the new tables. Pools were to hang off the settings row:

> `tournament_event_pools` (id, **draw_settings_id**, name, `slot_date DATE`,
> `slot_start TIME`, `slot_end TIME`)

The same ADR flagged, two paragraphs later, a trap that ticket must not walk
into:

> a fixture's pool must belong to *that fixture's own event* — a plain FK to
> `tournament_event_pools.id` does not say so, and needs a composite FK.

Both are right individually. Together they do not work, and nobody noticed until
someone tried to write the DDL.

A composite FK needs a **column in common** between the referencing and
referenced tables. `tournament_fixtures` is event-scoped through and through: it
carries `event_id`, its identity constraint is
`UNIQUE (event_id, pool_id, round, position)`, its index is on `event_id`, and
every read of a draw is "the fixtures of this event".
`tournament_event_draw_settings`, by contrast, deliberately carries **no
`event_id`** — the FK points parent→child (`tournament_events.draw_settings_id`),
and its docstring is emphatic that "that direction is the whole point", because a
`NOT NULL` FK on the parent is what keeps a 1:1 side table mandatory in a schema
that cannot say "exactly one child row".

So a pool keyed by `draw_settings_id` shares no column with a fixture, and the
composite FK the ADR demanded cannot be written. The ways to force it are all
worse: give fixtures a `draw_settings_id` too (denormalizing the fixture table
and needing a *second* composite FK, `(event_id, draw_settings_id) →
tournament_events (id, draw_settings_id)`, to stop the two disagreeing), or give
pools both parents and a composite FK proving they agree (one permanently
redundant column). Two composite FKs, or a redundant column, to say one thing.

## Decision

**`tournament_event_pools` hangs off `event_id`.**

```sql
tournament_event_pools (
  id          uuid PRIMARY KEY,
  event_id    uuid NOT NULL REFERENCES tournament_events (id) ON DELETE CASCADE,
  name        text NOT NULL,
  position    int  NOT NULL,
  slot_date   date NOT NULL,
  slot_start  time NOT NULL,
  slot_end    time NOT NULL,
  UNIQUE (event_id, id),
  UNIQUE (event_id, position)
)
```

and the fixture says what the 2026-07-26 ADR wanted it to say, in one line:

```sql
FOREIGN KEY (event_id, pool_id) REFERENCES tournament_event_pools (event_id, id)
```

`UNIQUE (event_id, id)` is redundant against the primary key and exists purely as
the target that composite FK needs.

**Why the settings row is the wrong parent.** `tournament_event_draw_settings` is
a **1:1 side table holding a settings blob** — a draw type and the per-type
scalars that go with it (`qualifiers_per_pool`, and whatever #787 adds). Pools
are not scalars of a configuration. They are a **1:N collection of entities**
with their own identity, their own join table to tables, and fixtures
foreign-keying into them. Hanging that off the 1:1 side table adds a hop that
buys nothing and costs exactly the composite FK the ADR itself flagged.

The 2026-07-26 ADR's own principle — "per-type reference data and per-event
configuration are different tables, and stay that way" — was drawn between
`draw_types` and `tournament_event_draw_settings`. A pool is a third kind of
thing that neither box fits: not reference data, not a configuration scalar, but
an entity the event owns.

It is also what the code already believes. Pools live on the event today and
survive a draw-type change; the settings row is mutated in place
(`event.draw_settings.configure(...)`), never replaced. `event_id` preserves that
exactly.

**Pools carry an explicit `position`.** This is not in the 2026-07-26 sketch and
it is the column most likely to be dropped as incidental, so: it is load-bearing.
Pool *order* is currently carried implicitly, by two things that both disappear
in this change — the JSONB array's order, and the lexicographic sort of
client-minted ids like `p-1-…`, `p-2-…`. Three sites depend on it, including
`DrawConfig.pool_ids`, which is documented as "in the event's own pool order —
that order is what the snake seeds against, so it must not be re-sorted". Under
random UUIDv4 primary keys, sorting by id is **arbitrary**: pools render in a
random order and the snake seeds against a random order, producing a draw that
still cuts but seeds differently. That is exactly the failure the 2026-07-26 ADR
predicted for this half of the work — "a draw that still cuts but places matches
wrongly: invisible to the type checker, findable only by QA". An explicit
ordering column is the only thing that survives the id change.

**The tournament-scoping stops at the join table.** A pool reserving another
tournament's table is the same illegal state one level deeper, and
`tournament_event_pool_tables` carries `tournament_id` with composite FKs to both
sides so it cannot be constructed. It is not pushed further than that — the join
row is the only place a cross-tournament reference could be written, so keying it
is sufficient and anything beyond is redundancy for its own sake.

## Consequences

The 2026-07-26 ADR's table sketch is wrong on one row and should be read through
this one. Its reasoning is not wrong; the sketch simply predated anyone trying to
spell the composite FK out, which is what the grill is for.

Draw settings stay exactly as thin as that ADR said they would be — draw type
plus `qualifiers_per_pool` — rather than growing pools. That ADR called the thin
row "not empty" and justified it on the draw type alone, so nothing it promised
depends on pools moving in.

`ON DELETE CASCADE` from `tournament_events` gives pools the same lifecycle
fixtures and entries already have, so the existing event-delete path
(`passive_deletes`, one cascading statement) keeps working without learning about
a new parent.
