# Tournament times are timezone-aware instants, anchored by a per-event venue timezone

Date: 2026-07-19 (date-prefixed; sequential ADR numbers collide across concurrent
worktrees, so recent ADRs are dated, not numbered)

## Status

Accepted. **Supersedes ADR-0790** ("A placement is a naive, predicted start time
on the fixture") on the representation question it explicitly left open:

> Modelling a tournament timezone and moving both onto `timestamptz` is the
> more-correct long-term answer; it is a larger decision than D1 needs, and is
> left open.

This ADR takes that larger decision. ADR-0790's other rulings stand: a placement
still lives on the **fixture** (not the match), the start time is still a soft
**prediction** whose constraints are read-derived flags (never hard invariants),
and the schedule is still **tournament-scoped**. Only the *frame* of the times
changes here.

## Context

The CP-SAT scheduler made ADR-0790's naive-wall-clock frame load-bearing and it
broke (issues #1068, #1104, #1067, #1101):

- The solver builds one integer-minute axis whose origin is the earliest pool
  window start — a **naive venue wall-clock** datetime — but compares it against
  `now = datetime.now(UTC)`, the **server's UTC wall-clock**. The two land on the
  same axis at different wall-clock positions (offset by the UTC offset, and
  possibly a calendar day). A director entering "today 18:00–23:45" at 19:20
  America/Chicago gets an instant "the day doesn't fit" — the window reads as
  already past in UTC (#1068).
- `pinned_at` is written `datetime.now(UTC)` but rendered by the schedule surfaces
  as if it were venue-local, so called times display in UTC (#1104).
- Once real wall-clock passes a pool window's end, every *unpinned* fixture must
  start `≥ now > window_end`, so the schedule wedges into a permanent, 0-ms
  "doesn't fit" with no director recovery (#1067).
- A genuinely past-dated window (most easily reached via the silent "today"
  default, #1095) fails the same opaque way, indistinguishable from a real
  capacity shortfall (#1101).

The root cause is that a wall-clock time in this domain **was not anchored to a
real instant** — the domain modelled no timezone, so "18:00" could not be placed
on the same axis as `now`.

## Decision

### A time in a tournament is a wall-clock *intent* anchored to an instant by a venue timezone

Two representations, chosen per role:

- **Director-entered planning windows stay wall-clock components + a timezone.**
  An event/pool **Slot** remains JSONB `{date, start, end}` strings (`YYYY-MM-DD`,
  `HH:MM`). What changes: a new **`timezone`** column on `tournament_events` (IANA
  name, e.g. `America/Chicago`), `NOT NULL`, that *anchors* those components. The
  instant is composed on demand, server-side, from `(date, start, end, timezone)`
  with stdlib `zoneinfo`. This keeps **wall-clock the durable intent**: the
  planned local time is what the director meant, and it is what is stored.

- **System-computed placement times are `timestamptz` instants.**
  `tournament_fixtures.scheduled_start` and `pinned_at` migrate from naive
  `TIMESTAMP WITHOUT TIME ZONE` to `timestamptz`. These are *instants* — a solve's
  prediction or a call's timestamp — and the server writes them by composing the
  event-tz instant (for a placement's local start) or taking `now` (for a call).

`tournament.start_date` / `end_date` stay `Date`: calendar dates, not instants.

**Why per-event, not per-tournament.** The timezone is a pure *presentation and
entry* concern once instants are the axis of computation — the solver operates on
instants regardless of how many timezones are in play — so putting it on the event
costs nothing and correctly models a rare multi-venue/multi-city tournament. The
default is browser-derived (`Intl.DateTimeFormat().resolvedOptions().timeZone`) at
event creation; single-venue tournaments (the common case) get one timezone across
every event for free.

### Wall-clock is preserved across a timezone edit

Correcting an event's timezone (picked Chicago, the venue is Denver) **holds the
wall-clock and moves the instant**, never the reverse — "the event is at 6 PM
local; I just fixed which local." For Slot windows this is *free*: the components
never change, only the composed instant does. For the two `timestamptz` columns a
director's manual placement is re-composed against the new timezone on the tz-edit
path (a solver output is a prediction and may simply be re-solved).

### All timezone arithmetic lives on the server; clients stay tz-math-free

The wire keeps human `{date, start, end}` + the event `timezone`. The BFF renders
each displayed time to a **venue-local label + timezone abbreviation** server-side
and ships that; where a surface needs geometry (the Gantt bar positions) it also
ships the raw **instant**, because positioning is tz-agnostic differencing. No
client (web or iOS) gains a timezone library, and the DST/ambiguity edge cases are
resolved once, in `zoneinfo`, at the boundary. This kills the client-side
`timeOfDay()` string-slice that faithfully displayed whatever frame the server put
in the field.

### A schedule surface always labels the timezone

Because a tournament-wide Schedule/Gantt can show fixtures from events in
different timezones on one timeline, every rendered time carries its timezone
label. Same-column bars must not silently imply simultaneity across frames.

### The solver stops wedging, and names a past day

- **Overrun is soft once live.** While `status == live`, a pool window's end is
  advisory: the effective end is `max(window_end, now + horizon)`, and the
  schedule surfaces an explicit **"overrunning"** state rather than "doesn't fit."
  A live tournament is never made structurally unschedulable by wall-clock passing
  a *planning* window. Pins still outrank windows, as in ADR-0790's successor work.
- **A past day is named, not disguised.** The solver pre-check distinguishes "this
  window is in the past" from a genuine capacity infeasibility and returns a
  specific, actionable message identifying the date. Prevention (not silently
  defaulting a new event to "today", and a low-friction "move to next open day")
  is **out of scope here** and stays with #1095 / #1101.

## Consequences

- The core scheduling defect (#1068) and the UTC-display defect (#1104) are fixed
  **structurally** by the anchoring, not by a special case: `now` and the windows
  finally share one instant axis.
- The app is **pre-deploy**, so the `scheduled_start` / `pinned_at` column changes
  are made by **editing the original migrations in place and wiping/re-migrating**
  a fresh database — no data backfill, no "alter" migration (per `api/CLAUDE.md`).
- The OpenAPI surface changes (the new `timezone` field, the reshaped
  displayed-time payloads), so both generated clients regenerate in the same
  change: `mise run regen-api-types` and `mise run regen-ios-api-types`. iOS app
  code changes only where it renders these fields.
- **#1101 stays open**: this ADR satisfies its "name the past day" half; its
  correction-path half rides with #1095.
- A future multi-day event (#1099) fits this frame unchanged — each day's window
  is already wall-clock components under one event timezone.
