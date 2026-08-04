// The mock `GET /v1/tournaments` handler's contract with the API it stands in for —
// specifically the **near-me** filter (the all-or-nothing `lat`/`lng`/`radius_miles`
// triple). These exercise the handler itself, over the same MSW server the whole suite and
// `npm run dev` share, so the Near-me control can be built and tested without a backend:
// with a location + radius the endpoint returns only nearby mock tournaments, each carrying
// a real haversine `distance_miles`; without, it returns them all with `distance_miles`
// null; and a partial triple 422s exactly as the server's does.
//
// The seed venues are at known, real coordinates, so the radii below are deterministic:
//   • Bay Area Open  — Berkeley   (37.8715, -122.273)   published, owned  → visible
//   • Summer Slam    — Palo Alto  (37.4419, -122.143)   draft,     owned  → visible
//   • Club Champs    — San Jose   (37.3382, -121.8863)  published, foreign→ visible
//   • Golden State   — Los Angeles(34.0522, -118.2437)  live,      owned  → visible
//   • Garage Invit.  — NO VENUE   (address: null)       published, owned  → visible
//   • League Office  — San Jose   draft, foreign                          → HIDDEN
// From Berkeley: Palo Alto ≈ 30.5 mi, San Jose ≈ 42.5 mi, Los Angeles ≈ 345 mi. So a
// 10-mile radius isolates Berkeley, a 35-mile one adds Palo Alto, and a wide one returns
// all five visible rows — except that the venue-less one is never a near-me result at all
// (see the last test).

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import { DRAW_SETTINGS_REFUSALS } from './handlers'
import { resetTournamentsStore } from './tournaments-store'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']
type TournamentEventRead = components['schemas']['TournamentEventRead']

// The dev user's own venue — a point ON the Bay Area Open's coordinates, so its distance
// rounds to 0 and the radii read like a map.
const BERKELEY = { lat: 37.8715, lng: -122.273 }

const BAY_AREA = 'bay-area-open-2026' // Berkeley
const SUMMER_SLAM = 'summer-slam-2026' // Palo Alto, ~30.5 mi
const CLUB_CHAMPS = 'club-champs-2026' // San Jose, ~42.5 mi
/** The seed's venue-less tournament (`address: null`) — visible in the plain list,
 * and never in a near-me one. */
const GARAGE = 'garage-invitational-2026'
/** The seed's two-stage tournament (ADR 20260727) — Los Angeles, ~345 mi, i.e. outside
 * every radius these tests search and inside the deliberately absurd one below. */
const GOLDEN_STATE = 'golden-state-classic-2026'

async function listTournaments(query = ''): Promise<{
  status: number
  body: TournamentDetailRead[]
}> {
  const res = await fetch(`http://localhost/v1/tournaments${query}`)
  return { status: res.status, body: (await res.json()) as TournamentDetailRead[] }
}

const idsOf = (rows: TournamentDetailRead[]) => rows.map((t) => t.id)
const byId = (rows: TournamentDetailRead[], id: string) =>
  rows.find((t) => t.id === id)

beforeEach(() => {
  resetTournamentsStore()
})
afterEach(() => {
  resetTournamentsStore()
})

describe('GET /v1/tournaments — the near-me filter', () => {
  it('with a location + radius, returns ONLY nearby tournaments, each with a distance_miles', async () => {
    const { status, body } = await listTournaments(
      `?lat=${BERKELEY.lat}&lng=${BERKELEY.lng}&radius_miles=10`,
    )

    expect(status).toBe(200)
    // A 10-mile radius around Berkeley keeps only the Berkeley venue; Palo Alto (~30.5)
    // and San Jose (~42.5) fall outside it.
    expect(idsOf(body)).toEqual([BAY_AREA])
    expect(byId(body, BAY_AREA)?.distance_miles).toBe(0)
    // Every returned row carries a real numeric distance — never null when a location was
    // asked about.
    for (const t of body) {
      expect(typeof t.distance_miles).toBe('number')
    }
  })

  it('widens the result set as the radius grows, and each distance is the haversine to that venue', async () => {
    const { body } = await listTournaments(
      `?lat=${BERKELEY.lat}&lng=${BERKELEY.lng}&radius_miles=35`,
    )

    // 35 miles now admits Palo Alto but still excludes San Jose.
    expect(idsOf(body).sort()).toEqual([BAY_AREA, SUMMER_SLAM].sort())
    expect(byId(body, BAY_AREA)?.distance_miles).toBe(0)
    expect(byId(body, SUMMER_SLAM)?.distance_miles).toBeCloseTo(30.5, 1)
    expect(idsOf(body)).not.toContain(CLUB_CHAMPS)
  })

  it('returns every visible tournament with distance_miles null when no location is sent', async () => {
    const { status, body } = await listTournaments()

    expect(status).toBe(200)
    // All five VISIBLE rows (the foreign draft stays hidden regardless), each with the
    // designed "no location asked about" distance — the venue-less one INCLUDED: having
    // no venue keeps a tournament out of proximity searches, not out of the list.
    expect(idsOf(body).sort()).toEqual(
      [BAY_AREA, CLUB_CHAMPS, GARAGE, GOLDEN_STATE, SUMMER_SLAM].sort(),
    )
    for (const t of body) {
      expect(t.distance_miles).toBeNull()
    }
  })

  // A tournament with NO VENUE is never a proximity-search result, at any radius
  // (CONTEXT.md, "Venue"): there is nothing to measure to. The server's SQL haversine
  // reads the address JSONB's coordinates, so a NULL address yields no distance and the
  // row never survives the radius comparison — and the mock must not be more generous,
  // or a venue-less tournament would appear in `npm run dev`'s near-me list (at a
  // defaulted (0, 0), i.e. thousands of miles out) and vanish in production.
  //
  // The radius is deliberately absurd: at 20 000 miles every point on Earth is inside
  // it, so the only thing that can still exclude this row is the rule under test.
  it('never returns a VENUE-LESS tournament from a near-me search, at any radius', async () => {
    const { body: tight } = await listTournaments(
      `?lat=${BERKELEY.lat}&lng=${BERKELEY.lng}&radius_miles=10`,
    )
    expect(idsOf(tight)).not.toContain(GARAGE)

    const { body: wholeEarth } = await listTournaments(
      `?lat=${BERKELEY.lat}&lng=${BERKELEY.lng}&radius_miles=20000`,
    )
    expect(idsOf(wholeEarth)).not.toContain(GARAGE)
    // …while every VENUED row is inside a radius that large — so the assertion above
    // is about the missing venue and not about a filter that dropped everything.
    expect(idsOf(wholeEarth).sort()).toEqual(
      [BAY_AREA, CLUB_CHAMPS, GOLDEN_STATE, SUMMER_SLAM].sort(),
    )
  })

  it('422s a PARTIAL triple — the location filter is all-or-nothing, as on the server', async () => {
    // A lat with no lng and no radius: the server 422s this rather than silently ignoring
    // it, so the mock must too.
    const { status } = await listTournaments(`?lat=${BERKELEY.lat}`)
    expect(status).toBe(422)

    // Two of three is still partial.
    const { status: twoOfThree } = await listTournaments(
      `?lat=${BERKELEY.lat}&lng=${BERKELEY.lng}`,
    )
    expect(twoOfThree).toBe(422)
  })
})

/**
 * The event write boundary's **draw configuration** check (ADR 20260727) — the mock's
 * mirror of the server's tagged union, exercised over the same MSW server the app and
 * `npm run dev` use.
 *
 * WHY THIS IS TESTED AT ALL. The rule lives on the server as a discriminated union
 * (`api/app/schemas/tournament.py`): `RrThenKoDrawSettingsWrite` requires
 * `qualifiers_per_pool` with `ge=1` and no default, the `round-robin`/`single-elim` arms
 * declare no such field and are `extra="forbid"`, and `TournamentEventUpdate`'s
 * `_parse_draw_settings` refuses a count arriving without a `draw_type` beside it. The
 * mock restates that by hand, and a hand-maintained mirror drifts **both** ways with a
 * green suite: too strict and it invents 422s that only appear in `npm run dev`; too lax
 * and it stops catching the class of bug it exists for (a client authoring a body the
 * real API refuses — which is exactly how a silent 422 shipped earlier in this arc).
 *
 * WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT. The load-bearing claims are the
 * **status**, the **offending field**, and **which rule fired** — the last one pinned by
 * naming the mock's own `DRAW_SETTINGS_REFUSALS` entry, so a branch reds for its own
 * reason and not merely reds. No sentence is retyped here: re-asserting the words would
 * be a fragile test of wording rather than a robust test of the rule, and the wording is
 * free to change without touching a test. In particular these do NOT quote **Pydantic's**
 * vocabulary ("Field required", "Extra inputs are not permitted", …): nothing pins the
 * real server to those strings either, so a library bump could desynchronise the mock
 * from production with the suite still green.
 *
 * The ACCEPT cases are not padding. A mirror mutated to refuse everything satisfies every
 * refusal case above and would ship a boundary that rejects valid events; the same shape
 * of corruption (an `ELSE FALSE` in a database constraint) has already been caught on
 * this arc only by an accept case.
 */
describe('the event write boundary — the draw configuration (ADR 20260727)', () => {
  /** A valid event create body, minus the draw configuration the cases supply. */
  const baseCreate = {
    name: 'Two-stage Singles',
    format: 'singles' as const,
    entry_fee: 20,
    timezone: 'America/Chicago',
    slot: { date: '2026-06-13', start: '09:00', end: '18:00' },
    match_settings: { rated: true, length_games: 5 as const },
  }

  /** `POST …/events` against the seeded, owned tournament. */
  async function createEvent(
    draw: Partial<components['schemas']['TournamentEventCreate']>,
  ) {
    const res = await fetch(`http://localhost/v1/tournaments/${BAY_AREA}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...baseCreate, ...draw }),
    })
    return { status: res.status, body: await res.json() }
  }

  /** `PATCH …/events/{id}` against a seeded event with **no draw cut**, so the draw-type
   * freeze (a 409, a different rule) can never be what answers these. */
  async function patchEvent(patch: components['schemas']['TournamentEventUpdate']) {
    const res = await fetch(
      `http://localhost/v1/tournaments/${BAY_AREA}/events/ev-open-singles`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      },
    )
    return { status: res.status, body: await res.json() }
  }

  /** The refusal, checked the robust way: a 422 whose detail names the field the director
   * must fix, and IS the refusal for the rule that should have fired — identified by the
   * constant, so the assertion survives any rewording of it. */
  function expectRefusal(
    result: { status: number; body: unknown },
    rule: string,
  ) {
    expect(result.status).toBe(422)
    const { detail } = result.body as { detail: string }
    expect(detail).toContain('qualifiers_per_pool')
    expect(detail).toBe(rule)
  }

  // ----- the rr-then-ko arm: required, and ge=1 ------------------------------
  describe('an rr-then-ko event', () => {
    it('is refused with NO qualifier count — the arm requires one, with no default', async () => {
      // There is no defensible number to assume ("2" is a convention, not a fact about
      // the event), so the server refuses rather than cutting a draw for a K nobody chose.
      const rule = DRAW_SETTINGS_REFUSALS.countRequired
      expectRefusal(await createEvent({ draw_type: 'rr-then-ko' }), rule)
      expectRefusal(await patchEvent({ draw_type: 'rr-then-ko' }), rule)
    })

    it.each([0, -1])('is refused with a count of %i — K >= 1', async (bad) => {
      // Zero advances nobody into the knockout stage; a negative count is not a count.
      const rule = DRAW_SETTINGS_REFUSALS.countTooSmall
      expectRefusal(
        await createEvent({ draw_type: 'rr-then-ko', qualifiers_per_pool: bad }),
        rule,
      )
      expectRefusal(
        await patchEvent({ draw_type: 'rr-then-ko', qualifiers_per_pool: bad }),
        rule,
      )
    })

    it('is refused with a count over 1000 — the same ceiling the server enforces', async () => {
      // A mock more permissive than the server here is exactly how a client ships a
      // body the API 422s: the server's `qualifiers_per_pool` field is `le=1000`.
      const rule = DRAW_SETTINGS_REFUSALS.countTooLarge
      expectRefusal(
        await createEvent({ draw_type: 'rr-then-ko', qualifiers_per_pool: 1001 }),
        rule,
      )
      expectRefusal(
        await patchEvent({ draw_type: 'rr-then-ko', qualifiers_per_pool: 1001 }),
        rule,
      )
    })

    // ✅ ACCEPT. Without this, a mirror mutated to refuse everything passes every case
    // above — and the boundary would reject the very events it exists to admit.
    it('ACCEPTS a count of 1 or more, and stores it', async () => {
      const created = await createEvent({
        draw_type: 'rr-then-ko',
        qualifiers_per_pool: 2,
      })

      expect(created.status).toBe(201)
      // Round-tripped, not merely accepted: the value comes back on the read shape,
      // which is what the next cut sizes its bracket from.
      expect((created.body as TournamentEventRead).qualifiers_per_pool).toBe(2)

      const patched = await patchEvent({
        draw_type: 'rr-then-ko',
        qualifiers_per_pool: 1,
      })
      expect(patched.status).toBe(200)
      expect((patched.body as TournamentEventRead).qualifiers_per_pool).toBe(1)
    })
  })

  // ----- the two count-less arms: extra="forbid" -----------------------------
  describe('a draw type with no knockout stage', () => {
    it.each(['round-robin', 'single-elim'] as const)(
      'refuses a qualifier count sent with %s — that arm forbids the key outright',
      async (drawType) => {
        // ⚠️ NOT a value silently dropped: the settings table's CHECK says NULL for every
        // draw type but rr-then-ko, and a director naming a count for a format with no
        // knockout stage has misunderstood something worth being told about.
        const rule = DRAW_SETTINGS_REFUSALS.countForbidden(drawType)
        expectRefusal(
          await createEvent({ draw_type: drawType, qualifiers_per_pool: 2 }),
          rule,
        )
        expectRefusal(
          await patchEvent({ draw_type: drawType, qualifiers_per_pool: 2 }),
          rule,
        )
      },
    )

    // ✅ ACCEPT — and the discriminating half of the rule above: it is the *key* that is
    // refused, never the draw type. An explicit `null` is accepted too, because absent and
    // null mean the same thing to the server's `_draw_settings_write` (it omits a `None`
    // before validating), and the client's own mapper sends neither.
    it.each(['round-robin', 'single-elim'] as const)(
      'ACCEPTS %s with no count at all, and stores null',
      async (drawType) => {
        const created = await createEvent({ draw_type: drawType })

        expect(created.status).toBe(201)
        expect((created.body as TournamentEventRead).qualifiers_per_pool).toBeNull()

        const withNull = await createEvent({
          draw_type: drawType,
          qualifiers_per_pool: null,
        })
        expect(withNull.status).toBe(201)
        expect((withNull.body as TournamentEventRead).qualifiers_per_pool).toBeNull()
      },
    )
  })

  // ----- the pair rule: a count never travels alone --------------------------
  it('refuses a qualifier count PATCHed with no draw type beside it', async () => {
    // Judging it would mean reading the event's *stored* draw type, two layers past the
    // boundary and after the request has been accepted — so the server refuses it at the
    // edge (`_parse_draw_settings`). The editor always sends both: it PATCHes the whole
    // form it rendered.
    expectRefusal(
      await patchEvent({ qualifiers_per_pool: 2 }),
      DRAW_SETTINGS_REFUSALS.countUnpaired,
    )
  })

  // ✅ ACCEPT — the discriminating twin of the case above. A patch that touches neither
  // half of the draw configuration is the ordinary edit (renaming an event, moving its
  // window), and a mirror that fired on the absence of a draw type would refuse ALL of
  // them while every refusal case above still passed.
  it('ACCEPTS a patch that names neither half of the draw configuration', async () => {
    const { status, body } = await patchEvent({ name: 'Renamed Singles' })

    expect(status).toBe(200)
    expect((body as TournamentEventRead).name).toBe('Renamed Singles')
    // …and the stored configuration is untouched by an edit that never mentioned it.
    expect((body as TournamentEventRead).draw_type).toBe('round-robin')
    expect((body as TournamentEventRead).qualifiers_per_pool).toBeNull()
  })
})

// ----- the tournament write boundary — the venue catalogue (ADR 20260801) --------
//
// The catalogue moved from a JSONB blob a client authored ids into, to child ROWS whose
// ids the SERVER mints, written as an id-keyed DIFF. Two of its consequences are wire
// facts a component can only meet through a handler, so they are asserted here rather
// than against the store: a create's response carries ids the client never sent, and a
// removal the state of the world forbids comes back as a **409 carrying the server's own
// sentence** (which the client shows verbatim) — not as a quietly-applied edit.
//
// A mock that answered that removal with a 200 would be more permissive than the API it
// stands in for: the Tables tab would look perfect in `npm run dev` and in vitest, and
// 409 in front of a director on the morning of their tournament.
describe('the tournament write boundary — the venue catalogue (ADR 20260801)', () => {
  /** Summer Slam: draft, owned, catalogue `T1`–`T8`, one drawn round-robin. */
  const SLAM = SUMMER_SLAM

  async function getTournament(id: string) {
    const res = await fetch(`http://localhost/v1/tournaments/${id}`)
    return { status: res.status, body: (await res.json()) as TournamentDetailRead }
  }

  async function patchTournament(
    id: string,
    patch: components['schemas']['TournamentUpdate'],
  ) {
    const res = await fetch(`http://localhost/v1/tournaments/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
    return { status: res.status, body: await res.json() }
  }

  /** The tournament's catalogue as a PATCH body carries it: every table cited by id, so
   * this alone is a no-op diff and dropping an entry from it is a removal. */
  const upsertsOf = (t: TournamentDetailRead) =>
    t.table_catalogue.map((tbl) => ({
      id: tbl.id,
      label: tbl.label,
      court: tbl.court,
    }))

  /** Place Summer Slam's first pool fixture on its first table, over the wire. */
  async function placeAFixture(): Promise<{ fixtureId: string; tableId: string }> {
    const { body } = await getTournament(SLAM)
    const tableId = body.table_catalogue[0].id
    const fixtureId = body.events.flatMap((e) => e.fixtures)[0].id
    const res = await fetch(
      `http://localhost/v1/tournaments/${SLAM}/fixtures/${fixtureId}/placement`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          table_id: tableId,
          scheduled_start: '2026-08-22T09:00:00',
        }),
      },
    )
    expect(res.status).toBe(200)
    return { fixtureId, tableId }
  }

  it('mints an id for every table on a CREATE — the body carries none', async () => {
    const res = await fetch('http://localhost/v1/tournaments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Minted Over The Wire',
        description: null,
        start_date: null,
        end_date: null,
        address: null,
        // `TournamentTableWrite` — no `id` is even sendable.
        table_catalogue: [{ label: 'T1', court: 'A' }],
      }),
    })

    expect(res.status).toBe(201)
    const created = (await res.json()) as components['schemas']['TournamentRead']
    const [table] = created.table_catalogue
    expect(table).toMatchObject({ label: 'T1', court: 'A' })
    expect(table.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
  })

  it('409s a removal a placement stands in the way of, and writes nothing', async () => {
    const { tableId } = await placeAFixture()
    const before = (await getTournament(SLAM)).body

    const { status, body } = await patchTournament(SLAM, {
      // The rename rides along, so a guard that refused *after* writing is caught.
      name: 'Renamed While Removing',
      table_catalogue: upsertsOf(before).filter((t) => t.id !== tableId),
    })

    expect(status).toBe(409)
    // A bare `detail` STRING — the shape `extractDetail` reads and the editor's banner
    // shows verbatim, because the sentence is the domain's, not a validator's.
    const { detail } = body as { detail: string }
    expect(detail).toContain('“T1”')
    expect(detail).toContain('1 match')
    expect(detail).toContain('unplace_fixtures_on_removed_tables')
    // …and named by LABEL, never by the id the diff actually compared.
    expect(detail).not.toContain(tableId)

    const after = (await getTournament(SLAM)).body
    expect(after.table_catalogue).toEqual(before.table_catalogue)
    expect(after.name).toBe(before.name)
    expect(after.events.flatMap((e) => e.fixtures)[0].table_id).toBe(tableId)
  })

  it('accepts the same removal with the opt-in, leaving those fixtures unplaced', async () => {
    const { fixtureId, tableId } = await placeAFixture()
    const before = (await getTournament(SLAM)).body

    const { status } = await patchTournament(SLAM, {
      name: 'Renamed While Removing',
      table_catalogue: upsertsOf(before).filter((t) => t.id !== tableId),
      unplace_fixtures_on_removed_tables: true,
    })

    expect(status).toBe(200)
    const after = (await getTournament(SLAM)).body
    expect(after.table_catalogue.map((t) => t.id)).not.toContain(tableId)
    expect(after.name).toBe('Renamed While Removing')
    const fixture = after.events
      .flatMap((e) => e.fixtures)
      .find((f) => f.id === fixtureId)!
    expect(fixture.table_id).toBeNull()
    expect(fixture.scheduled_start).toBeNull()
    expect(fixture.pinned_at).toBeNull()
  })

  it('422s an entry citing an id this catalogue does not hold, naming the entry', async () => {
    const before = (await getTournament(SLAM)).body

    const { status, body } = await patchTournament(SLAM, {
      table_catalogue: [
        ...upsertsOf(before),
        { id: 'not-a-table-of-this-tournament', label: 'T9', court: '9' },
      ],
    })

    expect(status).toBe(422)
    // FastAPI's per-field array, so `validationFields` (`src/api/client.ts`) can blame
    // the Tables row rather than falling through to the generic sentence.
    const { detail } = body as {
      detail: { loc: (string | number)[]; msg: string }[]
    }
    expect(detail[0].loc).toEqual([
      'body',
      'table_catalogue',
      before.table_catalogue.length,
      'id',
    ])
    expect(detail[0].msg).toBe(
      "This tournament's venue catalogue has no table with that id.",
    )
    // Nothing minted, nothing removed.
    expect((await getTournament(SLAM)).body.table_catalogue).toEqual(
      before.table_catalogue,
    )
  })
})
