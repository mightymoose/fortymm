# A venue's coordinates are geocoded server-side at write time and are NOT NULL; the browser only displays them

Date: 2026-07-25 (date-prefixed; sequential ADR numbers collide across concurrent
worktrees, so recent ADRs are dated, not numbered)

## Status

Accepted, and **amended 2026-07-26** — read the Amendment at the end before relying
on anything here. **The title is now too strong:** coordinates are NOT NULL *within
an address*, but a tournament may have **no address at all**. The amendment also
records that the geocoder is chosen by explicit config rather than inferred from key
presence (#1206, #1205). The filename is left alone so existing links keep working.

This ADR is the design output of the `/grill` on issue #1169 ("Near me"
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

## Amendment (2026-07-26): the invariant narrows, and the geocoder is chosen explicitly

Two defects found in UAT after this ADR shipped (#1206, #1205) narrow two of its
claims. Neither reverses the decision — everything argued above survives — but a
reader who takes the headline literally will be wrong twice, so both are recorded
here rather than left to be discovered in the code.

### "Coordinates are NOT NULL" becomes "an address, when present, has NOT NULL coordinates"

This ADR made the address effectively **mandatory** as a side effect nobody chose:
create/edit geocode on write, and an all-blank address composes to `""`, which
resolves to zero candidates and is refused. Before #1198 an all-blank address was
representable, and it was a state organizers actually used — a tournament announced
before the venue is booked, or a small private tournament at somebody's home whose
address should not be pinned on a public map. This ADR made that state unreachable
through **every** write path — web, MCP, and future iOS — with no discussion.

So `tournaments.address` becomes **nullable**, and `TournamentRead.address` becomes
`Address | None`. The invariant narrows from *"coordinates are NOT NULL"* to
**"an address, when present, has NOT NULL coordinates."**

What the ADR argued for is untouched: the server is still the single authority for
coordinates, no client ever supplies a lat/lng, and no reader threads
`Optional[float]`. We deliberately did **not** make `latitude`/`longitude` optional
on `Address` — that would create a half-populated address (venue text present,
location unknown) that every reader must defend against and that no write path can
even produce. A nullable value-object adds exactly one new state, "this tournament
has no venue," which is meaningful and which the UI was already built for (the
detail page's `venue &&` gate, `joinPresent` in `data/helpers.ts`).

Two rules make that one state single-valued:

- **All-blank normalises to `None` at the boundary**, before the geocoder is asked.
  Otherwise the state stays unreachable from the web form, which submits six
  controlled inputs and has no gesture meaning "the `address` key is absent" — the
  browser organizer, the person the bug is about, would still get a 409 for leaving
  the venue empty. Because a present address must geocode, an all-blank address can
  never be *stored*, so SQL `NULL` remains the one representation of "no venue".
- **On PATCH: omitted means unchanged; `null` or an all-blank object means remove.**
  `TournamentUpdate` stops rejecting an explicit `null` for `address` — that
  rejection's stated reason was "these map to NOT NULL columns," which is now false.
  The trap: `edit_tournament` used `updates.address is not None` to mean "an address
  is on the payload," and that identity breaks the moment `None` means "remove." Both
  sites move to `"address" in updates.model_fields_set`.

**No venue is valid at every status**, draft through archived. It is not a
precondition of publishing or of going live: that gate exists so the *draw* is right
at the instant play starts, and a venue has no bearing on it. An address-less
tournament simply never matches a proximity search — the SQL already degrades that
way, since `_venue_coordinate` casts a missing key to NULL and the bounding-box
comparisons exclude the row. (That function's docstring claims the cast "never meets
a null"; it was false in UAT and is corrected.)

**The venue stays a value-object; we did not extract a `venues` table.** It is
tempting — reused venues would stop re-geocoding a known address, real lat/lng
columns would index better than a JSONB text cast, and a venue entity is the natural
home for the timezone `CONTEXT.md` notes this domain lacks. We declined because the
address's eventual owner is a **Club**, not a free-floating Venue, so a `venues`
table would likely be the wrong shape as well as premature. It is also orthogonal:
`tournaments.venue_id` would need to be nullable regardless, so extracting the table
saves none of this work.

### The geocoder is selected by explicit config, not inferred from key presence

The "injectable seam" section above is right that the provider is swappable, but the
implementation chose between them by **inferring from key presence** — a key means
`GoogleGeocoder`, no key means `FakeGeocoder`. That **fails silently open**: an
environment meant to geocode for real, whose key is missing or rotated out, does not
error. It quietly hashes addresses into pseudo-random coordinates and stores them as
though they were real. Nothing logs and nothing 500s; the map just renders the wrong
continent. UAT was doing exactly this — "Summer Open, Chicago IL 60625" resolved to
Antarctica — which made UAT useless for validating the very feature this ADR adds.

Selection moves to an explicit `GEOCODER` setting, a closed enum (`google` | `fake`)
**defaulting to `google`**, validated on `Settings` itself so `google` without a key
raises at construction. The asymmetry is the point: **the safe choice is the default;
the test double must be asked for by name.** There is no path where silence selects
the fake. The check lives on the model rather than in `get_geocoder` because
`get_geocoder` is only the FastAPI path — the RQ worker and any script construct
`Settings` too, and one guard covers every entrypoint. `lifespan` already calls
`get_settings()`, so a misconfigured deploy dies at boot instead of writing bad rows.

`FakeGeocoder` stays. Requiring the key in deployed environments does not obviate the
double: tests need determinism (the near-me e2e asserts exact coordinates), the
`UNRESOLVABLE_SENTINEL` exercises the zero-result → coded-409 path without a network
call, and CI would otherwise need a live key, egress and quota per run — which
fork PRs cannot have. The goal is to make choosing the double **deliberate**, not to
remove it.

**UAT is set `GEOCODER: fake` explicitly, for now** — it has no Google key, and
declaring that beats booting into it by accident. Its existing hash-derived
coordinates therefore stop being wrong: they are what a fake geocoder produces in an
environment that says it uses one. Re-geocoding them is deferred until UAT gets a
real key, at which point the `optional: true` on the secret ref in
`deploy/uat/templates/api.yaml` — which is what let it boot keyless — should go too.
</content>
</invoke>
