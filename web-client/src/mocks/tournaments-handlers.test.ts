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
//   • League Office  — San Jose   draft, foreign                          → HIDDEN
// From Berkeley: Palo Alto ≈ 30.5 mi, San Jose ≈ 42.5 mi. So a 10-mile radius isolates
// Berkeley, a 35-mile one adds Palo Alto, and a wide one returns all three visible rows.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { components } from '@/api/schema'
import { resetTournamentsStore } from './tournaments-store'

type TournamentDetailRead = components['schemas']['TournamentDetailRead']

// The dev user's own venue — a point ON the Bay Area Open's coordinates, so its distance
// rounds to 0 and the radii read like a map.
const BERKELEY = { lat: 37.8715, lng: -122.273 }

const BAY_AREA = 'bay-area-open-2026' // Berkeley
const SUMMER_SLAM = 'summer-slam-2026' // Palo Alto, ~30.5 mi
const CLUB_CHAMPS = 'club-champs-2026' // San Jose, ~42.5 mi

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
    // All three VISIBLE rows (the foreign draft stays hidden regardless), each with the
    // designed "no location asked about" distance.
    expect(idsOf(body).sort()).toEqual([BAY_AREA, CLUB_CHAMPS, SUMMER_SLAM].sort())
    for (const t of body) {
      expect(t.distance_miles).toBeNull()
    }
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
