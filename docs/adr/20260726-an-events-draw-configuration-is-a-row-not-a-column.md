# An event's draw configuration is a row, not a column

Date: 2026-07-26 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted — decided before implementation, alongside "A draw type is a seeded row,
and the enum holds only what runs" (same date), which this ADR assumes. Scopes
work across three tickets: #1086 lands the settings table, a follow-on ticket
normalizes pools and tables, and #787 adds the first per-draw-type setting.

## Context

Draw configuration is currently spread across `tournament_events` as a mix of a
Postgres enum and untyped JSONB:

- `draw_type` — the enum, addressed by the companion ADR.
- `pools` — `Mapped[list[dict[str, Any]]]` JSONB. Each pool carries `id`, `name`,
  a `slot` (date/start/end as **strings**, "to mirror the front-end prototype's
  wire shape"), and `table_ids: list[str]`.
- The venue's `table_catalogue` is JSONB on `Tournament`.

Nothing connects those refs. The codebase says so in three places, each written
as an apology for a guard it had to hand-code instead:

- `tournament_events.py:219` — "A fixture names its pool by a **string ref** into
  this same event's `pools` JSONB, and there is no pools table for it to
  foreign-key. So the database cannot refuse [it]." This is why
  `_enforce_pool_set_frozen` exists as ~60 lines of application code.
- `tournament_fixture.py:149` — `table_id` is "deliberately not a foreign key,
  there is no tables [table]".
- `ValueObjectId` (`schemas/tournament.py:120`) is an `Annotated[str,
  Field(min_length=1)]` that exists *only* because "pools and tables have no
  tables of their own, so a pool is addressed by a client-supplied string and
  nothing in the database constrains it."

Meanwhile #787 will add `qualifiers_per_pool` — genuinely per-**event**
configuration. The reference table from the companion ADR is per-**type** data
and is emphatically not its home; conflating them is the corner this ADR exists
to avoid.

## Decision

**An event's draw configuration is a row in `tournament_event_draw_settings`,
and `tournament_events` holds a `NOT NULL` FK to it.** There is no `draw_type`
column on `tournament_events`.

This is the `MatchSettings` shape, already in the repo: `match_settings` owns its
own `id`, and `matches.match_settings_id` is a `NOT NULL` FK. That direction
matters. Moving a mandatory attribute into a 1:1 side table normally makes it
optional at the schema level — SQL cannot express "exactly one child row" — and
every reader then has to handle an absence that should be impossible, which is
the `assert x is not None` anti-pattern `api/CLAUDE.md` forbids. A `NOT NULL` FK
on the parent keeps it mandatory in the database.

The settings row carries `draw_type_key`, a `NOT NULL` FK to `draw_types.key`
with `ON DELETE RESTRICT`. The draw type therefore lives in exactly one place,
so an event whose draw type disagrees with its settings is not a state that can
be constructed.

**Exactly one settings row per event — not one per (event, draw type) pair.** The
alternative was tempting: draw type is freely editable until the draw is cut
(`_enforce_draw_type_frozen`), so keying settings by `(event_id, draw_type_key)`
would let a director switch away and back with their settings retained. We
rejected it. A stale `swiss` settings row surviving on a round-robin event is a
landmine every reader — the planner, the preview, the panel — must remember to
filter past; one live row makes that impossible rather than conventional. And
retention has a cheaper home: draw type is only switchable pre-cut, when nothing
is committed, so the client can hold abandoned settings in form state. That is a
form concern, not a schema concern, and it does not put a contradictory row in
Postgres.

**Per-type reference data and per-event configuration are different tables, and
stay that way.** `draw_types` rows describe a draw type — its slug, label,
description, display order. `tournament_event_draw_settings` rows describe *this
event's* use of one. `qualifiers_per_pool` is per-event and belongs in the
latter; a default value for it, if one is ever wanted, is per-type and belongs in
the former. Settings are validated as a Pydantic **discriminated union tagged by
the slug** (`Field(discriminator="draw_type")` over `RoundRobinSettings |
SingleElimSettings`), which is how #787 adds a variant without touching anything
else, and why the slug being a stable primary key matters.

**Pools and tables become real tables, in a follow-on ticket.** "Foreign keys
everywhere" only means something for pools if pools are rows:

| New | Replaces |
| --- | --- |
| `tournament_tables` (id, tournament_id, label, court) | `Tournament.table_catalogue` JSONB |
| `tournament_event_pools` (id, draw_settings_id, name, `slot_date DATE`, `slot_start TIME`, `slot_end TIME`) | `TournamentEvent.pools` JSONB |
| `tournament_event_pool_tables` (pool_id, table_id) | `Pool.table_ids[]` string refs |
| `tournament_fixtures.pool_id` → FK | dangling string ref |
| `tournament_fixtures.table_id` → FK | dangling string ref |

`ON DELETE RESTRICT` on the fixture→pool FK then enforces in Postgres the exact
rule `_enforce_pool_set_frozen` hand-codes, and `ValueObjectId` is deleted
outright.

Two traps that ticket must not walk into. The slot columns stay `DATE`/`TIME`,
**not** `timestamptz`: they are wall-clock windows anchored by
`TournamentEvent.timezone`, which is deliberate, and reads like a violation of
`api/CLAUDE.md`'s "datetimes are timezone-aware, always" unless stated. And a
fixture's pool must belong to *that fixture's own event* — a plain FK to
`tournament_event_pools.id` does not say so, and needs a composite FK.

**Three tickets, not one.** #1086 stops after the settings table. The split is
not about diff size; the two halves fail differently. The draw-type half is
type-driven — shrink the enum and mypy walks you to every site. The pools half is
a data-shape change through a CP-SAT solver and a scheduling preview, where the
failure mode is a draw that still cuts but places matches wrongly: invisible to
the type checker, findable only by QA. Reviewed together, the interesting half
hides inside the mechanical one, and the only honest thing anyone could say about
a 40-file combined diff is "the suite is green" — which is precisely the claim
`.claude/rules/verify-the-artifact-under-test.md` exists to reject.

## Consequences

`tournament_event_draw_settings` lands in #1086 holding one meaningful column,
`draw_type_key`, until the pools ticket moves `pools` into it and #787 adds
`qualifiers_per_pool`. That is thin, but it is not empty: it holds the draw type,
so it has real content and real behaviour to verify from the day it ships. An
empty table would have been a design claim with nothing to test.

Every read of `event.draw_type` across the API becomes
`event.draw_settings.draw_type` — around thirteen modules, including the four
exhaustive `match` sites (`draws.py`, `results.py`, `schedule_preview.py`,
`dashboard_tournaments.py`). The loader must eager-load the settings row wherever
it already eager-loads events, or the change trades an enum read for an N+1.

Migrations 0010 and 0012 are edited **in place** per `api/CLAUDE.md`'s pre-deploy
rule, revision ids and `down_revision` chain frozen, and the `draw_type` Postgres
enum type is dropped. Because `pytest` builds the schema with
`create_all` and never runs Alembic, a green suite is not evidence any of this
migrates — `alembic upgrade head` against a fresh empty Postgres, with the FKs
and seeded rows inspected, is a required step and not a formality.

The follow-on ticket changes `PoolId` from `str` to `uuid.UUID` through the
*pure* domain layer in `draws.py`, which reaches `results.py`, the scheduler
inputs, the dashboard BFF, the draw panel and the MSW store. Sequencing it after
#1086 means it starts from a model where draw configuration already has one home.
