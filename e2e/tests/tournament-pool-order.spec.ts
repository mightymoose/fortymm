import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
import { guestFromContext } from '../support/match-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  getEventPools,
  getScheduleDetail,
  seedEntrants,
  seedTournament,
  transitionTournament,
  type PoolSpec,
  type TableSpec,
} from '../support/tournament-api'

const EVENT_NAME = 'Open Singles'

/** **Ten** pools — the smallest number that reproduces the bug, and not negotiable.
 * The collision needs a two-digit pool number: `p-10-` sorts between `p-1-` and `p-2-`,
 * so ten pools ordered by id read 1, 10, 2, 3 … 9. With nine, the id order and the
 * position order coincide exactly and the spec would prove nothing. */
const POOL_COUNT = 10

/** Two entrants per pool — the round-robin cut refuses a pool of fewer than two
 * (`_snake`: "a lone entrant has nobody to play"), so this is the floor. Twenty guests
 * is already the expensive part of this spec; a third per pool would buy no new fact
 * about ordering. */
const ENTRANTS_PER_POOL = 2
const ENTRANT_COUNT = POOL_COUNT * ENTRANTS_PER_POOL

/** The base-36 suffix `genId('p')` appends — one shared "timestamp" for a burst of pools
 * added in the editor, which is exactly how a real ten-pool event's ids look. Fixing it
 * here keeps the ids' lexicographic order a property of the *index*, which is the thing
 * under test, rather than of when the spec happened to run. */
const ID_SUFFIX = 'mkq1x'

/** Ten tables, one per pool: ten pools sharing one table is a double-booking the editor
 * warns about, and this spec's subject is the order, not the warning. */
const TABLES: ReadonlyArray<TableSpec> = Array.from(
  { length: POOL_COUNT },
  (_, i) => ({ id: `t${i + 1}`, label: `Table ${i + 1}`, court: 'A' }),
)

/**
 * The ten pools **in the director's order**, `Pool 1` … `Pool 10`, with the ids the
 * event editor would have minted for them (`p-1-…` … `p-10-…`).
 *
 * The list's order is the payload's only statement about pool order — the server stamps
 * each pool's `position` from its index here (ADR 20260801) — and it is deliberately at
 * odds with both the ids' and the names' lexicographic order. That disagreement is the
 * entire experiment: a seed whose id order matched its intended order could not tell a
 * stack that orders by position from one that orders by id.
 */
const POOLS: ReadonlyArray<PoolSpec> = Array.from(
  { length: POOL_COUNT },
  (_, i) => ({
    id: `p-${i + 1}-${ID_SUFFIX}`,
    name: `Pool ${i + 1}`,
    tableIds: [`t${i + 1}`],
  }),
)

/** What the draw must read, top to bottom: `Pool 1`, `Pool 2`, … `Pool 10`. */
const NAMES_BY_POSITION = POOLS.map((pool) => pool.name)

/** The same ten pools sorted by **id**, by codepoint — the wrong answer, and the one
 * this stack actually produced before pools carried a position: `Pool 1`, `Pool 10`,
 * `Pool 2` … `Pool 9`. Compared against, not asserted on: it is how the spec proves its
 * own fixture is capable of failing. (`localeCompare` is deliberately avoided — it
 * collates digits by locale rules and would quietly stop reproducing the bug.) */
const NAMES_BY_ID = [...POOLS]
  .sort((a, b) => (a.id < b.id ? -1 : 1))
  .map((pool) => pool.name)

/**
 * Which entrants the snake deals into each pool, by **registration index**.
 *
 * Twenty entrants across ten pools is one pass forward and one back (`_snake`): pool `i`
 * takes registration `i` on the way out and registration `19 − i` on the way home. So
 * Pool 1 holds the 1st and 20th to register, Pool 2 the 2nd and 19th, and so on.
 *
 * This is the half of the ordering that a heading assertion cannot see. The deal seeds
 * against `DrawConfig.pool_ids`, so a stack that ordered those by id would deal the 2nd
 * registration into *Pool 10* while still rendering the ten headings in the right
 * order — "a draw that still cuts but seeds differently" (ADR 20260801), invisible on
 * the page unless you read the membership.
 */
const dealtTo = (poolIndex: number): [number, number] => [
  poolIndex,
  ENTRANT_COUNT - 1 - poolIndex,
]

/**
 * **A ten-pool event's draw reads 1 … 10, through the whole composed stack** (#1226,
 * ADR 20260801 "Pools carry an explicit `position`").
 *
 * Pool ids are client-minted strings — `p-1-…`, `p-2-…`, `p-10-…` — and sorted as
 * strings `p-10-` falls *between* `p-1-` and `p-2-`. Every site that ordered pools by id
 * therefore read a ten-pool event as 1, 10, 2, 3 … 9: the read query that returns the
 * fixtures, the `ready_fixtures` grouping, and `DrawConfig.pool_ids` — the order the
 * snake seeds against. A director with ten pools got a draw whose sections were in one
 * order and whose deal was in another.
 *
 * ## Why this claim needs the composed stack
 *
 * The api tests prove the server orders by position in isolation; the web-client tests
 * prove the renderer sorts correctly *given* pools that carry one. Neither can see the
 * two halves disagree — and the disagreement is the whole bug, because `position` is a
 * field the client is **forbidden** to send (`PoolWrite` is `extra="forbid"`; a create
 * body carrying one is a 422). The order the director typed survives only if the server
 * derives it from the list, stores it, serializes it, and the browser reads it back the
 * same way. This is the only suite where all four are the real thing.
 *
 * So the order is asserted at three places along that path, on one seeded event:
 *
 * 1. **The server stamped it.** The pools read back carry positions 0…9 matching the
 *    order they were sent — the fact a client cannot manufacture, since it cannot send
 *    the field at all.
 * 2. **The wire carries it.** The detail's fixtures arrive grouped by pool in position
 *    order, so the pool ids' first appearances read `p-1-…` … `p-10-…` and not
 *    `p-1-…, p-10-…, p-2-…`.
 * 3. **The browser renders it** — the ten headings top to bottom, *and* the membership
 *    the deal put under each one. The second is the assertion that would red for a stack
 *    that ordered `DrawConfig.pool_ids` by id, which the headings alone would not.
 *
 * ## Seed vs UI split
 *
 * Over the API (`support/tournament-api.ts`): the tournament, the ten-pool event, the
 * publish, and twenty director-entered guests — twenty browser sign-ins to test a *draw*
 * would be twenty chances to fail for an unrelated reason, and director-entry has no web
 * UI at all. In the browser: **cutting the draw** and reading it, which is the surface
 * whose order is the subject.
 *
 * ## RBAC
 *
 * As in `tournament-lifecycle.spec.ts`: a minted user holds only the permissionless
 * default role, so `grantBetaTester` hands the director the tournament bundle over the
 * stack's own `postgres` container before any tournament write. Skipped against an
 * external `E2E_BASE_URL` stack, where the caller owns provisioning.
 */
test.describe('Tournament — ten-pool draw order', () => {
  test('a ten-pool draw reads Pool 1 through Pool 10, and is dealt in that order', async ({
    page,
    baseURL,
  }) => {
    // Twenty minted guests, each a session + a typeahead + a director-entry, then a real
    // cut across ten pools — far past the 30s default.
    test.setTimeout(300_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    // The fixture's own falsification guard: if the ids ever came to sort the way the
    // positions do, every assertion below would still pass and none of them would mean
    // anything. Fail here, where the reason is legible, rather than three screens away.
    expect(
      NAMES_BY_ID,
      'the seeded pool ids must sort DIFFERENTLY from their positions, or this spec cannot fail',
    ).not.toEqual(NAMES_BY_POSITION)

    // The director IS the browser's own session, so page navigations run as them.
    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ----- seed: a tournament whose event has ten pools, in order -------------
    const name = `Pools ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, poolIds } = await seedTournament(director, name, {
      tables: TABLES,
      pools: POOLS,
    })

    // ----- 1. the SERVER stamped the order the director sent ------------------
    // Positions 0…9 against the pools in the sent order. A client could not have
    // produced this: `position` is not a field it may send.
    const storedPools = await getEventPools(director, tournamentId, eventId)
    expect(storedPools.map((pool) => pool.id)).toEqual(poolIds)
    expect(storedPools.map((pool) => pool.position)).toEqual(
      POOLS.map((_, index) => index),
    )

    // ----- publish, then fill the field --------------------------------------
    await transitionTournament(director, tournamentId, 'published')
    const entrants = await seedEntrants(
      director,
      baseURL!,
      tournamentId,
      eventId,
      ENTRANT_COUNT,
    )

    // ----- cut the draw, in the browser --------------------------------------
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    // `toContainText`, not `toHaveText`: the hero sets its own full stop after the name.
    // The long timeout is for the FIRST navigation only, and it is about the stack rather
    // than the app — the composed web-client is a Vite **dev** server, so the first
    // request for a route pays for transforming it on demand.
    await expect(detail.title).toContainText(name, { timeout: 60_000 })

    const drawPost = page.waitForResponse(
      (r) => r.url().endsWith('/draw') && r.request().method() === 'POST',
    )
    await detail.generateDrawButton(EVENT_NAME).click()
    const drawResponse = await drawPost
    expect(
      drawResponse.status(),
      `cutting the draw was refused: ${await drawResponse.text()}`,
    ).toBe(201)

    // ----- 3. the BROWSER renders the ten pools in the director's order -------
    // One statement, and it pins both the count and the order: ten headings reading
    // Pool 1 … Pool 10, top to bottom. Ordered by id they would read Pool 1, Pool 10,
    // Pool 2 …, which is what this stack did before positions existed.
    await expect(detail.poolDrawHeadings(eventId)).toHaveText(NAMES_BY_POSITION)

    // ----- …and the DEAL followed the same order -----------------------------
    // The headings can be right while the field under them is wrong: the snake seeds
    // against the event's pool order, so a stack ordering that by id deals the 2nd
    // registration into Pool 10. Membership is derived from each pool's own fixtures
    // (ADR-0786), so this also says the fixtures were written into the right pools.
    for (const [index, poolName] of NAMES_BY_POSITION.entries()) {
      const [first, second] = dealtTo(index)
      await expect(
        detail.poolEntrants(eventId, poolName),
        `${poolName} holds the wrong entrants — the draw was dealt in the wrong pool order`,
      ).toHaveText([entrants[first].username, entrants[second].username])
    }

    // ----- 2. and the WIRE carried that order to get here ---------------------
    // Read last, of the draw the browser just cut: the detail's fixtures come back
    // ordered by their pool's position, so the pool ids in first-appearance order are the
    // server's own statement of the event's pool order — the one the page above rendered.
    const schedule = await getScheduleDetail(director, tournamentId)
    const fixtures = schedule.events.find((e) => e.id === eventId)?.fixtures ?? []
    expect(fixtures).toHaveLength(POOL_COUNT)
    const poolIdsOnTheWire = [
      ...new Set(
        fixtures.flatMap((fixture) =>
          fixture.pool_id === null ? [] : [fixture.pool_id],
        ),
      ),
    ]
    expect(poolIdsOnTheWire).toEqual(poolIds)

    await Promise.all(entrants.map((entrant) => entrant.ctx.dispose()))
  })
})
