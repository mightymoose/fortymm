# A draw type is a seeded row, and the enum holds only what runs

Date: 2026-07-26 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted — decided before implementation, for issue #1086. Supersedes that
ticket's own acceptance criteria, which were written before #785 landed
single-elimination and are stale in two places (see Context).

## Context

`TournamentEvent.draw_type` is a Postgres `ENUM` with five members, of which
**two** have implementations: `strategy_for()` (`app/draws.py`) returns
`RoundRobinStrategy` and `SingleElimStrategy`, and `results_for()`
(`app/results.py`) mirrors it exactly with `RoundRobinResults` /
`SingleElimResults`. The other three — `double_elim`, `rr_then_ko`, `swiss` —
raise `UnsupportedDrawType` / `UnsupportedResultsType` at cut time.

So the schema, and therefore OpenAPI and both generated clients, advertise three
draw types the product cannot run. A director picks one from
`DRAW_TYPE_OPTIONS` (a hardcoded five-entry list in the web client), creates the
event successfully, enters players, and only discovers at the moment they cut the
draw that it was never possible. The refusal is well-worded and lands inline, but
it arrives after the user has done all the work.

Issue #1086 proposed a `draw_types` reference table keyed by slug, mirroring the
established `rating_strategies` / `notification_types` lookup pattern. It left
three things undecided, and stated two things that are no longer true:

- It says "seed only `round-robin` for now" and "creating an event with any draw
  type other than `round-robin` is rejected." Both were true when filed and are
  now wrong: single-elim shipped in #785. **The seed set is two rows.**
- It says `strategy_for()` "stays the exhaustive dispatch" so that "an un-backed
  slug can never be seeded without a matching strategy" — but does not say
  whether `UnsupportedDrawType` remains *reachable* once the table gates what a
  director can pick.
- It does not address that the answer orphans existing coverage.

Two facts found while deciding shaped the outcome.

**`UnsupportedDrawType` is already raised on a path that has nothing to do with
seeding.** `app/schedule_preview.py:262` raises it for `single_elim` — a
*supported* type — because the CP-SAT scheduler is round-robin-only: a pool-less
bracket has no windows to solve over. The exception therefore does not stand or
fall with the reference table.

**The `notification_types` precedent keeps its Python enum.**
`NotificationCategory` (a `StrEnum` in `app/notifications/taxonomy.py`) remains
the code-level closed set and the OpenAPI enum; the table carries display
metadata and an availability flag; the FK exists "so a value off the taxonomy
can't be stored"; and `tests/conftest.py` seeds the rows *from the enum* with an
autouse fixture, because the FK requires the parent rows to exist.

## Decision

**A row in `draw_types` means "this draw type has an implementation."** The seed
set is exactly the set of types that `strategy_for()` can dispatch: today
`round-robin` and `single-elim`. It is not a roadmap and it is not a taxonomy of
everything the sport has.

We considered seeding all five with an `is_active` flag — the shape
`notification_channels` uses for SMS, which is "surfaced in the preferences
matrix but greyed out and never delivered." We rejected it here. SMS is a
channel the *design* committed to showing, so the matrix looks broken without it;
nothing asks a director's setup flow to advertise a roadmap. More decisively, a
table containing every member one could ever write makes the `ON DELETE RESTRICT`
FK decorative — it would constrain nothing that could actually go wrong — whereas
under this decision the FK *is* the enforcement.

**`DrawType` shrinks to the two members that run.** `double_elim`, `rr_then_ko`
and `swiss` are removed from the enum. The enum and the seeded rows are then the
same set by construction, and four consequences follow for free:

- Pydantic rejects an unimplemented slug **at the boundary**, with a 422 naming
  the valid values. "No un-backed slug is selectable" needs no custom validator.
- OpenAPI advertises exactly two draw types, so `schema.d.ts` and `Types.swift`
  stop offering what we cannot run. This is the ticket's actual complaint, fixed
  at the layer that made it.
- `strategy_for()` and `results_for()` lose their raise-arms entirely, and
  `UnsupportedResultsType` becomes unreachable and is deleted.
- Adding a draw type is a type error at every dispatch site until it is handled —
  the property `strategy_for`'s exhaustive `match` was always for, now with no
  arm to lazily park a new member in.

**`UnsupportedDrawType` survives, on its own merits.** Not as defence-in-depth
against a mis-seeded table — under this decision that state is unrepresentable,
since a valid enum member is by definition one with a strategy — but because
`schedule_preview` still needs it for single-elim. It keeps its existing test on
that path.

**The slug is the primary key**, and the FK target for
`tournament_event_draw_settings.draw_type_key` (see the companion ADR). Changing
a slug is therefore a migration, which is the friction we want: the slug is what
binds the table to `DrawType` members, to the settings discriminated union, and
to both generated clients.

**The catalogue is served, not hardcoded.** `draw_types` carries `name`,
`description` and `display_order`, and the tournament-detail BFF payload exposes
them. `DRAW_TYPE_OPTIONS` and its five hardcoded labels are **deleted**; the
picker renders the rows the server sent. This is what makes "the table gates what
a director can pick" structural rather than a claim resting on two lists
agreeing — and it means adding a draw type is a seeded row with *zero* client
changes.

We accept the known cost: labels become DB seed data, so a copy tweak is a
migration. `api/CLAUDE.md` already complains about exactly this for notification
labels. The alternative — the table carrying a `name` no surface ever reads —
buys the drift problem without the benefit.

**A migration test guards the drift.** `pytest` never runs migrations
(`conftest.py` builds the schema with `Base.metadata.create_all`), and no CI job
runs Alembic at all, so the seed has no guard today — the same three-places-must-
change-together problem `api/CLAUDE.md` documents for notification types. A test
runs `alembic upgrade head` against the testcontainer and asserts the seeded
`key` set equals `{t.value for t in DrawType}`. That closes the hole the
notification types never got, and converts this change's manual
verify-the-migration step into an automated one.

## Consequences

`tournament_events.draw_type` stops existing as a column; the draw type moves to
the event's draw-settings row. That is the companion ADR's decision, not this
one's, but the two land together.

Because the enum shrinks, every fixture, seed and test naming a removed slug must
change. Three pieces of coverage rest on the cut-time refusal of an unimplemented
type: `web-client/e2e/tournaments/tournament-draw.spec.ts:202` (the named spec),
`:458` (the axe check, which uses the same event to get a refusal notice on
screen), and `api.hooks.test.tsx:1500`. **None is deleted.** The MSW seed's
`ev-u1500` is already "`rr-then-ko` with no pools", so flipping it to
`round-robin` leaves all three structurally identical and changes only the
*reason* — to the `DegenerateDraw` sentence both the API (`draws.py:559`) and the
store already emit verbatim, "A round-robin draw needs at least one pool." The
claim they protect (the panel echoes the server's refusal inline, in the server's
words, with no toast) is unchanged, and now rests on a refusal that stays
reachable permanently rather than one scheduled for deletion by #787.

Coverage rises rather than falls: the served catalogue admits a test that could
not be written before — *the picker offers exactly the seeded draw types* — which
states "no un-backed slug is selectable" at the point of choice rather than after
a doomed click.

The MSW store's `cutDraw` gate (`draw_type !== 'round-robin'`) is already stale
w.r.t. #785 and becomes actively wrong here: with the enum at two members it can
only ever fire for single-elim, the one supported type the store cannot plan. The
store gains a `planSingleElimFixtures` mirroring `SingleElimStrategy.plan_initial`
— byes as *absent* fixtures, never null-sided rows (ADR-0786) — and the gate is
deleted. Without it the e2e suite could never cover a single-elim cut at all.

#787 (rr-then-ko) is unblocked and gets cheaper: a seeded row, an enum member, a
strategy, a results strategy, and a settings variant. The type checker walks it
to all four dispatch sites, and the client needs no change.
