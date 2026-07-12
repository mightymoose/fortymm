# 935. A null player cap means "no cap"

Date: 2026-07-12

## Status

Accepted

## Context

An event's entrant cap (`tournament_events.max_players`) and its entry fee
(`tournament_events.entry_fee`) were both modelled as `NOT NULL` numeric columns,
and the request schemas enforced `max_players > 0` and `entry_fee >= 0`, with
`max_players` **required** on create.

A QA pass (#935) found that this left no way to express two states the product
plainly needs:

- **An event with no entrant cap.** Not every event is capped. With
  `max_players` required and `> 0`, the organizer had to invent a number; there
  was no value that meant "unbounded".
- **A blank numeric field.** Clearing the player-limit or entry-fee input in the
  editor coerced the value to `0` (via `Number('')` → `NaN`, then a `0`
  fallback), which the server then rejected with `Input should be greater than 0`
  — a rejection the client swallowed silently. So the field was effectively
  mandatory, could not be blanked, and failed without feedback when you tried.

The value `0` is also overloaded. For **entry fee**, `0` is a legitimate, distinct
value: a free event genuinely has an entry fee of zero. For **player limit**, `0`
is nonsense — a cap of zero admits nobody. Conflating "no cap", "blank", and "0"
into a single `0` sentinel loses information the UI needs (ADR 15 requires that
"absent" and "not-applicable" stay distinguishable, rendering an unset value as an
em-dash rather than a fabricated number).

## Decision

**A null `max_players` means the event is uncapped. A blank cap field submits
`null`, not `0`. Entry fee stays required and non-negative.**

Concretely:

1. **`max_players` is nullable; `null` is the "no cap" sentinel.** The column
   becomes `NULL`-able, and a database `CHECK (max_players > 0)` guarantees that
   *when present* the cap is a positive integer — so the only representable states
   are "a positive cap" or "no cap", never zero or negative. `TournamentEventCreate`
   makes it optional (`int | None`, `default=None`, still `gt=0` when supplied) and
   `TournamentEventRead` exposes it as `int | None`.

2. **`entry_fee` is required and non-negative.** It stays `NOT NULL` with a
   database `CHECK (entry_fee >= 0)`, so `0` (a free event) is legal and a negative
   fee is not. A blank entry-fee field is a validation error the editor surfaces
   inline — not a silent `0`.

3. **The editor never coerces blank to a number.** An empty player-limit field
   holds as empty and submits `null`; an empty entry-fee field is an inline
   "required" error. `0` remains a distinct, legitimate value for entry fee and an
   invalid one for player limit (caught by the same `> 0` rule the DB enforces).

4. **A no-cap event renders as uncapped everywhere it is read.** The read-only
   view renders `null` as an em-dash (ADR 15, via `ReadOnlyValue`). The event card
   shows the entered count with no denominator and no fill bar, and is never marked
   "full" — an uncapped event cannot be full.

The database `CHECK` constraints are the load-bearing part: they make the illegal
states (`max_players = 0`, a negative fee) unrepresentable at the storage boundary,
so no application path — the editor, a future import, a script — can create one.

## Consequences

- Organizers can create uncapped events, and can leave the cap blank without the
  field silently rewriting itself to `0` and then failing.
- `max_players` is `int | None` across the stack. Every reader must handle the
  `None` case: the response schema, the generated web (`number | null`) and iOS
  (`Swift.Int?`) types, and any capacity/`isFull` arithmetic (division by a null
  cap is the "no cap" branch, not `NaN`).
- Because `max_players` is now nullable, any future max-players *enforcement* at
  registration (the A3 / #783 work) must treat `null` as "admit everyone", not as
  a cap of zero.
- pytest builds its schema with `Base.metadata.create_all`, not by running the
  Alembic migrations, so a green test suite does **not** prove the `CHECK`
  constraints exist. They are verified by running the migration chain against a
  fresh Postgres.
- This is a pre-first-deploy schema change, so per `api/CLAUDE.md` the existing
  `0010` migration is edited in place and the database is wiped and re-migrated,
  rather than adding an alter-migration.
