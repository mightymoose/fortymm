import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { TournamentsListPage } from '../page-objects/tournaments-list.page'
import { guestFromContext, mintGuest } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getStoredAddress,
  getVenueCoords,
  listTournaments,
  listTournamentsNearMe,
  seedTournament,
} from '../support/tournament-api'

/**
 * **A tournament with no venue**, end to end against the REAL composed stack —
 * real Postgres, real API, real browser, no stubs.
 *
 * A tournament may have no venue at all, at every status (CONTEXT.md, "Venue";
 * the 2026-07-26 amendment to
 * docs/adr/20260725-a-venues-coordinates-are-geocoded-server-side-and-not-null.md).
 * It is a first-class state covering two situations that behave identically: the
 * room is **not booked yet**, and the venue is **deliberately withheld** — a small
 * tournament at somebody's home whose address must not be pinned on a public map.
 * Three facts have to hold together, and each layer verified only its own half:
 *
 * 1. It **saves**. A create with an empty venue is a 201, not the coded 409 an
 *    unlocatable address raises. Until #1206 the geocode-on-write made an all-blank
 *    address resolve to zero candidates, so the browser organizer who had not booked
 *    a room yet was refused — with a message about an address they never typed.
 * 2. Its page shows **nothing** where the venue would be. No line, no map, and
 *    above all no "TBD"-style placeholder: that copy promises a venue is coming,
 *    which is a lie for the withheld case, and implies a withheld address is merely
 *    missing data.
 * 3. It is **never a near-me result, at any radius.** The near-me SQL excludes it
 *    because a NULL `address` makes the coordinate cast NULL and every comparison
 *    against NULL drops the row — behaviour the domain wants, but which until now
 *    was an unasserted accident of the query rather than a tested guarantee.
 *
 * ## Why the browser, and why these seams
 *
 * Claim 1 is driven through the **create dialog** rather than the API, because the
 * dialog is where the bug lived: it submits six controlled inputs and has no gesture
 * meaning "omit the `address` key", so "no venue" is reachable from it only if
 * all-blank normalizes to null at the server's boundary. Claim 2 rides the same
 * browser session onto the detail page the create navigates to. Claim 3 is a pure
 * API assertion (the filter is server-side SQL; a browser would only add a
 * geolocation prompt between the spec and the thing under test), seeded through the
 * API helper's `address: null`.
 *
 * ## Non-vacuity
 *
 * Every absence here is paired with a presence that must hold in the same breath —
 * an "it is not there" assertion is free against a page that never rendered or a
 * result set that came back empty:
 *
 * - the venue-less detail page's missing line/map is paired with a **venued
 *   control** opened through the same page object and the same locators, which
 *   must show both;
 * - the near-me exclusions are paired with a **venued control that must be found**
 *   in the very same query;
 * - and the venue-less tournament is shown to be present and visible in the
 *   **unfiltered** list, so its absence from a radius query is the venue filter
 *   working rather than a tournament that was never there.
 *
 * ## The radius ladder, and a bug it deliberately avoids
 *
 * Each query is made **at the control venue's own coordinates**, so the control sits
 * at distance 0 — dead centre of the bounding-box prefilter, and inside any radius.
 * That matters: `_bounding_box` in `app/tournament_list.py` derives its longitude
 * half-width from the cosine of the *query point's* latitude, so the box is not the
 * superset its docstring claims and can drop a venue the haversine would keep. Rows
 * near the box's edge are what that bug bites; the point at the exact centre is
 * immune to it at every radius, which is why this spec can span a tiny, a modest and
 * a planet-covering radius without depending on the buggy edge. (The bug is real,
 * pre-existing, and awaiting its own ticket — it is not this change's, and this spec
 * is built not to be confused by it.)
 */

/** The radii each near-me query is run at, from "a neighbourhood" to "the whole
 * planet". The last is deliberately larger than the greatest possible great-circle
 * distance on Earth (~12,437 mi), so it returns EVERY located tournament on the
 * platform — and the venue-less one must still not be among them. "At any radius"
 * is not a claim a single radius can carry. */
const RADII_MILES = [0.5, 25, 12_500] as const

test.describe('a tournament with no venue', () => {
  test('is created from an empty venue form, and its page shows no venue line and no map', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The organizer IS the browser's own session (`page.request` shares the page
    // context's cookie jar), so the pages below load as them. The "Beta tester"
    // grant is what carries `tournament.create`/`view`; without it the list page
    // hides the very action this test presses.
    const organizer = await guestFromContext(page.request)
    grantBetaTester(organizer.username)

    const name = `No venue ${faker.string.alphanumeric(8)}`

    const list = await TournamentsListPage.navigateTo(page)
    await expect(list.newTournamentButton).toBeVisible()
    const dialog = await list.openNewTournament()
    await expect(dialog.dialog).toBeVisible()
    await dialog.nameInput.fill(name)
    // The venue block is on screen and untouched — this is a form the organizer
    // left blank, not a form with no venue fields.
    await expect(dialog.venueInput).toHaveValue('')

    // The create itself. Watching the POST is the point: a 201 is the whole of
    // claim 1, and it is the assertion that discriminates "saved with no venue"
    // from the coded 409 ("we couldn't locate that address") that an all-blank
    // address used to earn by reaching the geocoder.
    const createPost = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/v1/tournaments') &&
        r.request().method() === 'POST',
    )
    await dialog.createButton.click()
    const created = await createPost
    expect(
      created.status(),
      'creating a tournament with an empty venue must be a 201',
    ).toBe(201)
    const tournamentId = ((await created.json()) as { id: string }).id

    // The dialog closed over a success rather than staying open on a refusal —
    // it closes itself ONLY on the success path, so this is a second, independent
    // reading of the same fact.
    await expect(dialog.errorBanner).toHaveCount(0)
    await expect(dialog.dialog).toHaveCount(0)

    // And the server really stored "no venue" — SQL NULL, the single
    // representation of it, not six empty strings dressed up as an address.
    expect(
      await getStoredAddress(organizer, tournamentId),
      'an all-blank venue must normalize to no address at all',
    ).toBeNull()

    // ----- claim 2: the detail page shows nothing where the venue would be ----
    // The create navigates here on its own; assert that landing rather than
    // re-navigating, so what is under test is the page the organizer actually got.
    await expect(page).toHaveURL(new RegExp(`/tournaments/${tournamentId}$`))
    const detail = new TournamentDetailPage(page)
    // The page RENDERED. Without this the three absences below would pass just as
    // happily against a blank screen or a page that threw on `address.latitude`.
    await expect(detail.title).toContainText(name)
    await expect(detail.statusBadge).toBeVisible()

    // Absence, not an empty element: the meta item and the map are not in the DOM.
    await expect(detail.venueLine).toHaveCount(0)
    await expect(detail.venueMap).toHaveCount(0)
    // And no placeholder anywhere on the page. "Venue TBD" would be worse than
    // either rendering: it promises a venue that may never come, and calls a
    // deliberately withheld address missing data.
    await expect(page.locator('body')).not.toContainText(/TBD/i)
  })

  test('…while a tournament WITH a venue still shows both, through the same locators', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const organizer = await guestFromContext(page.request)
    grantBetaTester(organizer.username)

    // The positive control for the test above. Without it, both of its absence
    // assertions would pass against a detail page that had quietly stopped
    // rendering venues altogether, or against two testids that no longer exist.
    const venue = `Control Arena ${faker.string.uuid()}`
    const { tournamentId } = await seedTournament(
      organizer,
      `Venued ${faker.string.alphanumeric(8)}`,
      {
        address: {
          venue,
          street: faker.location.streetAddress(),
          city: faker.location.city(),
          region: faker.location.state({ abbreviated: true }),
          postal: faker.location.zipCode(),
          country: 'Testland',
        },
      },
    )

    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    await expect(detail.venueLine).toContainText(venue)
    // Keyless (this stack, dev and CI), `LocationMap` renders its labelled text
    // fallback rather than loading Google — `venueMap` matches either branch.
    await expect(detail.venueMap).toHaveCount(1)
  })

  test('never appears in a near-me radius result, at any radius', async ({
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const director = await mintGuest(baseURL!)
    grantBetaTester(director.username)

    // A located control and a venue-less subject, created by the same director in
    // the same shared stack, so the only difference between them is the venue.
    const { tournamentId: locatedId } = await seedTournament(
      director,
      `Located ${faker.string.alphanumeric(8)}`,
      {
        address: {
          venue: `${faker.company.name()} Arena ${faker.string.uuid()}`,
          street: faker.location.streetAddress(),
          city: faker.location.city(),
          region: faker.location.state({ abbreviated: true }),
          postal: faker.location.zipCode(),
          country: 'Testland',
        },
      },
    )
    const { tournamentId: venuelessId } = await seedTournament(
      director,
      `Venueless ${faker.string.alphanumeric(8)}`,
      { address: null },
    )

    // The venue-less one really has no venue stored — the premise of everything
    // below, read off the API rather than assumed from the seed.
    expect(await getStoredAddress(director, venuelessId)).toBeNull()

    // Both exist and are visible to this caller in the UNFILTERED list, each with
    // a null distance (no location was searched from). So when the venue-less one
    // vanishes from the radius queries below, that is the venue filter — not a
    // tournament that was never there, and not one this director cannot see.
    const unfiltered = await listTournaments(director)
    const unfilteredIds = unfiltered.map((t) => t.id)
    expect(unfilteredIds).toContain(locatedId)
    expect(unfilteredIds).toContain(venuelessId)
    expect(
      unfiltered.find((t) => t.id === venuelessId)?.distance_miles,
      'an unfiltered list carries no distance for anything',
    ).toBeNull()

    // Search FROM the located control's own venue. Its distance is 0, so it is
    // inside every radius and at the exact centre of the bounding box — immune to
    // the `_bounding_box` longitude approximation, which only ever drops rows near
    // the box's edge.
    const from = await getVenueCoords(director, locatedId)

    for (const radiusMiles of RADII_MILES) {
      const listing = await listTournamentsNearMe(director, {
        lat: from.latitude,
        lng: from.longitude,
        radiusMiles,
      })
      const ids = listing.map((t) => t.id)

      // The control MUST be found. This is what makes the exclusion below mean
      // something: "the venue-less one is absent" is true of an empty result set,
      // of a 403, and of a filter that excludes everything.
      expect(
        ids,
        `the located control must be within ${radiusMiles} mi of its own venue`,
      ).toContain(locatedId)
      expect(
        listing.find((t) => t.id === locatedId)?.distance_miles,
      ).toBeCloseTo(0, 5)

      // The claim. A venue-less tournament has no coordinates to be near
      // anything, so it is not a proximity result — not even of a radius that
      // covers the whole planet and returns every located tournament there is.
      expect(
        ids,
        `a venue-less tournament must not appear at a ${radiusMiles} mi radius`,
      ).not.toContain(venuelessId)
    }

    await director.ctx.dispose()
  })
})
