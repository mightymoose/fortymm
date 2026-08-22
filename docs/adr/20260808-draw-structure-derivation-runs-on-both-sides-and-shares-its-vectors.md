# Draw-structure derivation runs on both sides and shares its vectors

Date: 2026-08-08 (date-numbered, because sequential numbers collide across
concurrent worktrees. See `scripts/check-adr-numbering.sh`)

## Status

Accepted. Decided during the grill for #1320. Builds on
20260808-a-structural-setting-is-owned-by-the-director-or-derived-by-the-system.

> **Amended by #1386 (2026-08-17).** The derivation now takes **seven inputs, not
> eight**: the reservation row count is no longer one of them, so decisions 1 and 4
> read "seven" where they say "eight". The automatic group count derives from a
> default group size of five — `max(1, ceil(field / 5))`, sizes balanced across the
> count (#1370 decision 1) — instead of counting the event's reservation rows.
> Both sides now duplicate a **second constant**, `DEFAULT_GROUP_SIZE = 5`
> (`web-client/src/components/tournaments/data/draw-structure.ts` and
> `api/app/draw_structure.py`), pinned by both vector tables the way the
> Consequences section already describes for `DEFAULT_UNCAPPED_FIELD`. The Python
> derivation decision 2 requires now exists, but no request path calls it yet —
> #1387 is its first production caller, so the refusals still fire only at cut
> time until it lands.

## Context

The Draw structure tab recomputes as the director types. Pool count, pool sizes,
qualifiers, bracket size, byes and pool matches all change on each keystroke, and
so do the panels that report a disagreement or an impossible competition.

Two requirements pull in opposite directions.

The tab must answer instantly. A round trip per keystroke would make the
authoritative number lag behind the input that produced it, which is the exact
confusion #1320 sets out to remove.

The refusals must be real. "Impossible configurations disable Save changes" is a
claim about the app, not about one browser. The web client is not the only
client. `ios/` reads the same API, and the MCP server writes events too. A rule
enforced only in React is not enforced.

The app already refuses these three conditions, but only at cut time, inside
`api/app/draws.py`:

- `_snake` refuses a pool of fewer than two entrants.
- `RrThenKoStrategy.__post_init__` refuses more qualifiers than the smallest pool
  holds.
- The same strategy refuses one qualifier from a single pool, which leaves a
  knockout of one.

Those messages are already written, already reviewed, and already asserted. The
copy is pinned in `api/tests/test_draws.py` and again in
`api/tests/test_tournaments.py`.

## Decision

**The derivation is implemented twice, on purpose. The two implementations share
their test vectors, and the server owns the refusals.**

1. **A pure TypeScript derivation drives the tab.** One function takes the eight
   inputs and returns the full result, including the disagreement, the uneven
   notice, and the impossible problems. It renders nothing and fetches nothing.

2. **A pure Python derivation guards the API.** The same rules run when an event
   is created or patched, and the refusals fire before the row is written.

3. **Neither side is generated from the other.** There is no shared runtime, no
   WASM build, and no code generation step. The duplication is the cost of
   instant feedback plus real enforcement, and it is paid deliberately.

4. **One table of vectors is the contract.** Every case from #1320 is asserted on
   both sides with identical inputs and identical expected numbers. A change to
   the math that lands on one side and not the other fails a test.

5. **The server reuses its existing refusal copy.** The three impossible
   conditions keep the `DegenerateDraw` strings already in `draws.py`. The client
   writes its own, shorter copy for the panel, because the panel also offers
   fixes and the API cannot.

6. **The API validates the state the request would produce, not the fields the
   request carries.** A patch is applied to the event in memory, and the result
   is checked. This is what lets the director in #1320 escape: their event is
   already impossible, and they must be able to change pool count and qualifiers
   in one request.

## Consequences

**An existing impossible event still loads and still edits.** Only the save is
refused, and only while the result would still be impossible. Refusing to read
the event, or refusing every patch to it, would strand the one director this
issue is about.

**The API gains refusals it did not have.** Today an impossible configuration
saves and fails later at the cut. That is the behaviour #1320 calls out as wrong.
The new 422s are a deliberate change, and they reach every client, including
iOS.

**A green client test proves nothing about the API.** The shared vector table is
what ties them. A reviewer checking this work should read the two vector tables
side by side before reading either implementation.

**The client duplicates one constant.** The uncapped preview field of 16 is
`DEFAULT_UNCAPPED_FIELD` in `api/app/schedule_preview.py`. The client needs the
same number to label the preview basis. It is duplicated with a comment naming
the Python original, because a value used to render a label does not justify a
round trip.

**Drift is possible and the tests are the only thing that catches it.** This is
the known cost. It is preferred to the alternatives below, all of which trade a
worse property for removing it.

## Alternatives considered

**Derive on the server, and have the tab call a debounced endpoint.** Rejected.
It makes the authoritative number lag the keystroke that caused it, and it puts a
network failure between a director and a number the app already knows. It also
does not remove client logic, because the tab still has to decide what to render
while a request is in flight.

**Derive on the client only, and keep the server's refusals at cut time.**
Rejected. It leaves the invariant unenforced for iOS and for the MCP server, and
it keeps the exact failure #1320 reports, which is a configuration that saves
happily and fails much later with the wrong reason.

**Compile one implementation to run in both places.** Rejected as far more
machinery than the problem earns. The derivation is roughly fifty lines of
arithmetic.

**Have the server return the derived result on every event read, and let the tab
render it.** Rejected for the same lag reason as the debounced endpoint. It is
worth revisiting for the read path alone if the preview later needs a number the
client cannot compute.
