# The dashboard's "Your matches" path sorts by time, not draw order

Date: 2026-08-15 (date-numbered — sequential numbers collide across concurrent
worktrees; see `scripts/check-adr-numbering.sh`)

## Status

Accepted. Fixes #1297. Amends ADR-0786 (`0786-a-draw-is-cut-explicitly-and-
advanced-idempotently.md`) for one consumer only — see Scope below.

## Context

`app.dashboard_tournaments.build_tournament_panels` builds each event's "Your
matches" path — the caller's own fixtures, listed as `M1`, `M2`, `M3`, ... — from
`fixtures_by_event`, which returns every event's draw in **pool → round →
position** order (ADR-0786). The path list inherited that order unchanged.

Draw order is not schedule order once a director calls fixtures onto real
tables: `M1` might be called for noon, `M2` for 9:00 AM, `M3` for 9:45 AM. A
player reading the path top-to-bottom to see what is next went to the noon
match and missed the 9:00 AM one.

## Decision

**The path list is sorted by effective time ascending** — `pinned_at`, falling
back to `scheduled_start`, the same precedence the card's own time label already
uses (ADR "the schedule is solved, the call is pinned"). A fixture with neither
sorts LAST, after every timed one, keeping its relative draw order among other
untimed fixtures — so a not-yet-placed fixture does not jump to the top just for
lacking a time.

The focus-match pick (`_focus_fixture`) is unchanged in structure but now reads
consistently off the sorted list: among not-yet-played fixtures, the earliest by
effective time wins, with untimed fixtures falling back to draw order among
themselves.

## Scope — this does not touch `fixtures_by_event`

`fixtures_by_event`'s pool → round → position order stays exactly as ADR-0786
specifies it. That loader is shared with bracket rendering and other consumers
that need the draw's own topology, not a schedule. Only
`dashboard_tournaments.py`'s caller-scoped `my_fixtures` list — built from that
loader's output — is re-sorted, in the dashboard module, after the shared query
runs. Nothing about the query, the migration, or ADR-0786's fixture model
changes.

## Consequences

- A player's own schedule reads top-to-bottom in the order they will actually
  play it, regardless of which pool or round a fixture belongs to.
- Two fixtures that happen to share a placed time keep their draw-order relative
  position (a stable sort), so the ordering is still deterministic.
- Any other reader of `fixtures_by_event` is unaffected; this decision is scoped
  to the dashboard's own projection.
