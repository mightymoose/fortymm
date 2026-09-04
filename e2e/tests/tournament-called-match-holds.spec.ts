import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import {
  findUserId,
  guestFromContext,
  mintGuest,
  type Guest,
} from '../support/match-api'
import { listNotifications, noticesTitled } from '../support/notifications-api'
import { grantBetaTester } from '../support/rbac-grant'
import {
  callFixture,
  cutDraw,
  enterPlayer,
  fixtureBetween,
  getScheduleDetail,
  seedTournament,
  tomorrowUtc,
  transitionTournament,
} from '../support/tournament-api'

const CALLED = "You're up soon — "
const MOVED = 'Your match moved to '

/**
 * Once a match is called, it stays called (#1661, item 2; #1514).
 *
 * The QA pass found that calling one match re-timed matches that were already
 * called — `rigorous-fossa vs rigorous-deer`, called and with a game recorded, was
 * told "Your match moved … now starts around 11:21" because a *different* call
 * re-solved the day. One unplayed fixture reached `notified 5×` after four routine
 * director actions.
 *
 * The mechanism is the solver's own objective: a called match's start was a
 * variable that could slide later, and packing the table is worth more to the
 * objective than keeping a promise. This spec sets up exactly that temptation — one
 * table, a fixture called for 09:10, and unpinned fixtures that would pack tighter
 * if the called one slid to 09:15 — and holds the re-solve to the promise: the
 * called fixture keeps its time to the byte, its players are told nothing further,
 * and the plan is built around it.
 */
test.describe('Tournament — a called match holds its time through a re-solve', () => {
  test('the re-solve plans around the called fixture instead of sliding it and re-notifying', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // ONE table and four entrants: six fixtures competing for a single court is
    // what makes the solver want the earliest slot for everyone.
    const name = `Holds ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, tables } = await seedTournament(director, name)
    const guests: Guest[] = []
    for (let i = 0; i < 4; i += 1) guests.push(await mintGuest(baseURL!))
    await transitionTournament(director, tournamentId, 'published')
    for (const guest of guests) {
      await enterPlayer(
        director,
        tournamentId,
        eventId,
        await findUserId(director, guest.username),
      )
    }
    await cutDraw(director, tournamentId, eventId)
    await transitionTournament(director, tournamentId, 'live')

    const readDetail = () => getScheduleDetail(director, tournamentId)
    const readEvent = async () =>
      (await readDetail()).events.find((e) => e.id === eventId)!
    const seeded = await readEvent()
    const [a, b] = guests
    const entryOf = (guest: Guest) =>
      seeded.entrants.find((e) => e.username === guest.username)!.id
    const f1 = fixtureBetween(seeded.fixtures, entryOf(a), entryOf(b))

    // The go-live solve lands first, so the later "did the re-solve land" poll has
    // a ledger row to move past.
    await expect
      .poll(async () => (await readDetail()).latest_schedule_solve?.status ?? null, {
        timeout: 120_000,
        intervals: [2_000],
      })
      .toBe('succeeded')
    const goLiveSolveId = (await readDetail()).latest_schedule_solve!.id

    // ----- the call: A vs B, Table 1, 09:10 tomorrow — ten minutes into the window --
    // Off the 5-minute grid on purpose (the window opens 09:00): an unpinned fixture
    // placed at 09:00 would overlap it, and sliding the pin to 09:15 packs the table
    // tighter than waiting for it. That is the temptation under test.
    const promised = `${tomorrowUtc()}T09:10:00`
    await callFixture(director, tournamentId, f1.id, tables[0].id, {
      scheduledStart: promised,
    })
    const called = (await readEvent()).fixtures.find((f) => f.id === f1.id)!
    expect(called.pinned_at).not.toBeNull()
    expect(called.call_notified_count).toBe(1)
    expect(called.scheduled_start!.instant).toBe(`${promised}Z`)
    await expect
      .poll(async () => noticesTitled(await listNotifications(a), CALLED).length, {
        timeout: 15_000,
      })
      .toBe(1)

    // ----- the re-solve the call itself triggers must land -------------------------
    await expect
      .poll(
        async () => {
          const solve = (await readDetail()).latest_schedule_solve
          return solve !== null &&
            solve.id !== goLiveSolveId &&
            solve.status === 'succeeded'
            ? solve.status
            : null
        },
        { timeout: 120_000, intervals: [2_000] },
      )
      .toBe('succeeded')

    // ----- the promise holds -----------------------------------------------------
    const after = (await readEvent()).fixtures.find((f) => f.id === f1.id)!
    expect(after.table_id).toBe(tables[0].id)
    expect(after.scheduled_start!.instant).toBe(`${promised}Z`)
    expect(after.pinned_at).toEqual(called.pinned_at)
    expect(after.call_notified_count).toBe(1)
    // ...and the players were told once, with no correction.
    for (const player of [a, b]) {
      const feed = await listNotifications(player)
      expect(noticesTitled(feed, CALLED)).toHaveLength(1)
      expect(noticesTitled(feed, MOVED)).toHaveLength(0)
    }
    // The plan was built AROUND the promise: every other fixture on the one table
    // starts after the called one ends (15 minutes for a best-of-1).
    const others = (await readEvent()).fixtures.filter((f) => f.id !== f1.id)
    const promisedEnd = new Date(`${promised}Z`).getTime() + 15 * 60_000
    for (const other of others) {
      expect(other.scheduled_start, `fixture ${other.id} is placed`).not.toBeNull()
      const start = new Date(other.scheduled_start!.instant).getTime()
      expect(
        start >= promisedEnd || start + 15 * 60_000 <= new Date(`${promised}Z`).getTime(),
        `fixture ${other.id} at ${other.scheduled_start!.instant} does not overlap the promise`,
      ).toBe(true)
    }

    // The browser is the director's session and not otherwise needed here; keep
    // the fixture honest about it.
    expect(page).toBeTruthy()
    for (const guest of guests) await guest.ctx.dispose()
  })
})
