# A venue's coordinates are geocoded server-side at write time and are NOT NULL; the browser only displays them

Date: 2026-07-25 (date-prefixed; sequential ADR numbers collide across concurrent
worktrees, so recent ADRs are dated, not numbered)

## Status

Accepted. This ADR is the design output of the `/grill` on issue #1169 ("Near me"
tournament discovery). It **deliberately diverges from the approach the issue
proposed** — see Context — so the divergence is recorded here rather than left as a
surprise to the next reader who opens #1169 and finds the code doing the opposite.

## Context

Issue #1169 adds a real geographic radius filter to the tournament list
("tournaments within 50 miles of me"). Two gaps block it: a tournament's
`Address` value-object (`api/app/schemas/tournament.py`) is free text with **no
coordinates**, and there is nothing to compute a distance *from* or *to*.

The issue's proposed approach was **capture coordinates in the browser** via a
Google Places autocomplete on the venue field — `place.geometry.location` gives
the client lat/lng for free, and the API never needs a geocoding provider. Its own
"open design decisions" flagged the weak point: **non-web creators have no Place.**
The MCP `create_tournament`/`edit_tournament` tools (and a future iOS create flow)
submit an address without a browser, so a client-capture design either leaves those
callers unable to produce coordinates or forces a server-side geocode fallback
"just for them" — at which point a geocoding provider is in scope anyway, only on a
second code path.

Grilling that decision collapsed it: once a geocoder exists on the server for the
non-web callers, a client-supplied lat/lng is just an unverified number the server
must either trust (a parse-at-boundary smell) or re-check (wasted work). The clean
resolution is to make the **server the single authority** for coordinates and drop
client capture entirely.

The stack runs `postgres:16-alpine` (no PostGIS), so distance has to be computed
without a geography type.

## Decision

### A venue is geocoded server-side on every write; coordinates are NOT NULL

`Address` grows `latitude` / `longitude`, both **NOT NULL**. The shared
transport-neutral `create_tournament` / `edit_tournament` verbs geocode the address
before the write, so **every** caller — web, MCP, future iOS — gets correct
coordinates through **one** path. There is no client-supplied coordinate anywhere on
the wire, so there is no "do we trust the browser's number" boundary question.

Because the app is **pre-deploy**, the new NOT NULL columns need no backfill: per
`api/CLAUDE.md` we edit the migration in place and wipe existing tournaments rather
than chaining a data migration. NOT NULL is the whole point — no `Optional[float]`
leaking through every downstream read, and no "tournament that mysteriously never
appears in near-me" state.

### An unresolvable address is a 422 at the boundary

Geocoding returns ranked candidates. We take the top-ranked candidate; **zero
results is a 422** ("We couldn't locate that address," a machine-readable code so
the MCP adapter can surface it too), never a silent write of null/0,0. This is what
lets the columns stay NOT NULL: a write that cannot produce coordinates fails loudly
at the edge (parse-at-boundaries) instead of leaking a bad row inward.

We store coordinates **only** — the organizer's typed address text is left exactly
as entered. Normalizing the free-text components to the geocoder's canonical form is
a real improvement but a separate concern with its own UX surprises; it needs no
schema change and is deliberately deferred.

### The geocoder is an injectable seam

Geocoding lives behind a `Geocoder` **Protocol** (a `GoogleGeocoder` real
implementation, a `FakeGeocoder` for tests), wired through `dependencies.py` into
the verbs — so the test suite never touches Google's network and the provider is
swappable. Google is the provider we picked (an API key already exists); it is not
load-bearing on the design.

### Distance is a haversine expression, not PostGIS

`GET /v1/tournaments` gains an all-or-nothing `lat` / `lng` / `radius_miles` query
triple and filters by a **haversine distance in SQL with a cheap bounding-box
prefilter**, returning a `distance_miles` per tournament. At this data volume the
haversine is right and it keeps the Postgres image (and the UAT Helm chart)
unchanged. Radius filtering goes in the **endpoint**, not client-side like the name
search and status tabs, because it is the first filter with a genuine server-side
reason: eventually you do not want to ship every tournament on the platform to a
phone.

### The browser gets a map, but only to *display* coordinates

The web loads Google Maps JS (a browser-referrer-restricted key,
`VITE_GOOGLE_MAPS_API_KEY`, distinct from the server's IP-restricted geocoding key)
purely to **render pins it never authors**: a venue pin on the detail page, and a
confirmation pin on the create/edit form fed by a small read-only
`GET /v1/geocode?address=…` preview endpoint (triggered by an explicit "Preview
location" button, not as-you-type, to keep geocoding cost trivial). The map is a
confirmation/display affordance; the coordinates that get stored always come from
the server geocode on write.

## Consequences

- **Changing `Address` is an OpenAPI change**, so both generated clients regenerate
  in the same change: `mise run regen-api-types`
  (`web-client/src/api/schema.d.ts`) and `mise run regen-ios-api-types`
  (`ios/Fortymm/Generated/Types.swift`), plus every fixture that builds an address
  (`web-client/src/mocks/factories/tournaments/tournament.factory.ts`,
  `web-client/src/mocks/tournaments-store.ts`,
  `web-client/src/components/tournaments/data/seed.factory.ts`,
  `e2e/support/tournament-api.ts`).
- **"Me" is never persisted.** The list page reads `navigator.geolocation` at query
  time and passes it through; `User` gains no location fields. Denial/unavailable is
  a graceful fallback to the unfiltered list, and near-me is opt-in.
- **A geocoding provider is now a runtime dependency of tournament creation** — the
  thing the issue's client-capture approach was designed to avoid. We accepted it
  because it makes MCP/iOS first-class rather than a fallback, and behind the
  `Geocoder` Protocol it stays swappable and test-fakeable.
- **Anonymous access is unchanged.** The list stays behind `require_view`; near-me
  does not open it to anonymous callers (#1169's open decision 5 stays closed).
</content>
</invoke>
