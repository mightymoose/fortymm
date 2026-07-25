import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { mintGuest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getVenueCoords,
  listTournamentsNearMe,
  listTournamentsRaw,
  seedTournament,
  type AddressInput,
  type Coords,
} from '../support/tournament-api'

// End-to-end proof of the tournament list's **near-me distance filter** against
// the REAL composed stack (browser-less, but every hop is real: nginx → api →
// postgres). `GET /v1/tournaments?lat&lng&radius_miles` filters to the venues
// within `radius_miles` of the point and stamps each survivor with its
// server-computed `distance_miles` (a haversine great-circle distance). This
// spec seeds two venues at a KNOWN separation, queries a radius that brackets
// one but not the other, and asserts the near one comes back with a distance and
// the far one is excluded — by real computed distance, not by guessed literals.
//
// ## Where the coordinates come from — why nothing is hardcoded
//
// The compose stack sets no `GOOGLE_GEOCODING_API_KEY`, so venue coordinates are
// produced by the deterministic, network-free `FakeGeocoder`, which maps the
// composed address string to stable lat/lng by SHA-256. That mapping is stable
// but not something a spec should reproduce — so the spec seeds two *distinct*
// addresses, reads back each venue's stored coordinates (`getVenueCoords`), and
// derives its query point and radii from those real numbers using the SAME
// haversine (Earth radius 3958.8 mi) the API computes with. The query point is
// placed AT the near venue (distance 0, unconditionally inside); the radius is
// half the near→far separation, so the far venue (a full separation away) is
// necessarily outside. Robust to whatever coordinates the two addresses hash to.

/** The Earth's mean radius in miles — the exact constant the API's haversine is
 * scaled by (`app/tournament_list.py`), so this spec's distance math mirrors the
 * server's rather than approximating it. */
const EARTH_RADIUS_MILES = 3958.8

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180

/** The haversine great-circle distance between two points, in miles — a term-for
 * -term mirror of `_distance_miles_column` in `app/tournament_list.py`, so the
 * distance this spec expects is the distance the API computes. */
function haversineMiles(from: Coords, to: Coords): number {
  const dLat = toRadians(to.latitude - from.latitude)
  const dLng = toRadians(to.longitude - from.longitude)
  const sinHalfLat = Math.sin(dLat / 2)
  const sinHalfLng = Math.sin(dLng / 2)
  const a =
    sinHalfLat * sinHalfLat +
    Math.cos(toRadians(from.latitude)) *
      Math.cos(toRadians(to.latitude)) *
      sinHalfLng *
      sinHalfLng
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.sqrt(a))
}

/** A fresh, unique venue address — a distinct string each call so the
 * `FakeGeocoder` hashes it to its own stable point, letting the spec seed two
 * venues that are genuinely apart. */
function uniqueAddress(): AddressInput {
  return {
    venue: `${faker.company.name()} Arena ${faker.string.uuid()}`,
    street: faker.location.streetAddress(),
    city: faker.location.city(),
    region: faker.location.state({ abbreviated: true }),
    postal: faker.location.zipCode(),
    country: 'Testland',
  }
}

test.describe('tournament list — near-me distance filter', () => {
  test('a radius query includes the near venue with its distance and excludes the far one', async ({
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const director = await mintGuest(baseURL!)
    // An ephemeral guest holds no tournament permissions; the "Beta tester" role
    // is what grants `tournament.view`/`create`, so without it every seed and
    // list 403s (see `rbac-grant.ts`).
    grantBetaTester(director.username)

    // Two tournaments at two distinct addresses → two distinct, stable
    // FakeGeocoder points. Names are unique so the ids are the only join key the
    // assertions rely on (the shared stack holds other tournaments too).
    const nearName = `Near ${faker.string.uuid()}`
    const farName = `Far ${faker.string.uuid()}`
    const near = await seedTournament(director, nearName, { address: uniqueAddress() })
    const far = await seedTournament(director, farName, { address: uniqueAddress() })

    // Discover the real coordinates the server geocoded each venue to — the
    // spec measures from these, never from a hardcoded literal.
    const nearCoords = await getVenueCoords(director, near.tournamentId)
    const farCoords = await getVenueCoords(director, far.tournamentId)

    const separation = haversineMiles(nearCoords, farCoords)
    // Distinct SHA-256 outputs → distinct points → a real separation. A zero
    // separation would mean the two addresses hashed to the same coordinates
    // (astronomically unlikely) and would make the radius choice below
    // meaningless — fail loudly with the reason rather than on a later assertion.
    expect(
      separation,
      'the two seeded venues must geocode to different points',
    ).toBeGreaterThan(0)

    // Query AT the near venue. The near venue's distance from the point is 0
    // (unconditionally inside); a radius of half the separation is strictly less
    // than the full separation to the far venue, so the far venue is outside.
    const tightRadius = separation / 2
    const listing = await listTournamentsNearMe(director, {
      lat: nearCoords.latitude,
      lng: nearCoords.longitude,
      radiusMiles: tightRadius,
    })

    const nearRow = listing.find((t) => t.id === near.tournamentId)
    const farRow = listing.find((t) => t.id === far.tournamentId)

    // The near venue is returned, carrying a real (here, ~zero) distance.
    expect(nearRow, 'the near tournament must be within the radius').toBeDefined()
    expect(nearRow!.distance_miles).not.toBeNull()
    expect(nearRow!.distance_miles!).toBeCloseTo(0, 5)

    // The far venue is excluded — by distance, since it is a full separation away
    // and the radius only reaches half that far.
    expect(farRow, 'the far tournament must be outside the radius').toBeUndefined()

    // Widening the radius past the full separation lets the far venue back in —
    // and it comes back stamped with the exact distance this spec computed
    // independently, proving `distance_miles` is the real haversine, not a flag.
    const wideList = await listTournamentsNearMe(director, {
      lat: nearCoords.latitude,
      lng: nearCoords.longitude,
      radiusMiles: separation * 2,
    })
    const farInWide = wideList.find((t) => t.id === far.tournamentId)
    expect(farInWide, 'a wide radius must now include the far tournament').toBeDefined()
    expect(farInWide!.distance_miles).not.toBeNull()
    // The API rounds `distance_miles` to one decimal; allow for that plus any
    // JS↔Postgres float drift (far below 0.1 mi over any Earth-scale distance).
    expect(Math.abs(farInWide!.distance_miles! - separation)).toBeLessThan(0.2)
  })

  test('a partial lat/lng/radius_miles triple is rejected (422)', async ({ baseURL }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const guest = await mintGuest(baseURL!)
    // `tournament.view` is required to reach the handler's all-or-nothing check;
    // without the grant the list 403s before it can 422 the partial triple.
    grantBetaTester(guest.username)

    // The three params describe ONE location filter, not three independent knobs
    // — supplying some but not all is a boundary rejection, not a silently
    // ignored param.
    const res = await listTournamentsRaw(guest, { lat: 40, lng: -74 })
    expect(res.status()).toBe(422)
  })
})
