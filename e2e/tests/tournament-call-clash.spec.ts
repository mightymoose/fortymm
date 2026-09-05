import { test, expect } from '@playwright/test'
import { faker } from '@faker-js/faker'

import { TournamentDetailPage } from '../page-objects/tournament-detail.page'
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
  naiveWallClock,
  placeFixtureRaw,
  seedTournament,
  transitionTournament,
} from '../support/tournament-api'

const TABLES = [
  { label: 'Table 1', court: 'A' },
  { label: 'Table 2', court: 'A' },
]

const CALLED = "You're up soon — "
const MOVED = 'Your match moved to '

/**
 * A player is never called to two matches at once (#1661, items 1 and 3).
 *
 * The QA pass that filed #1661 moved `persimmon-dog vs rigorous-fossa` onto a table
 * that already held `persimmon-dog vs imported-starfish`, called and unplayed. The
 * app accepted it: both rows read Called on the same table, the player held two
 * "head to the table" instructions, and the re-solve then sent a "moved" correction
 * naming a time the player was never promised — two messages, in the same second,
 * that disagreed.
 *
 * The bar this spec holds the stack to: while a tournament is live, a placement that
 * would call a fixture onto a **table** or a **player** still held by an unfinished
 * called match is **refused** — a 409 naming the clash — and refused before anyone
 * is told anything. The director is warned; the players hear nothing. Read three
 * ways: the API's status and sentence, each player's persisted feed (exactly one
 * call, never a correction), and the director's own Schedule tab, where the refusal
 * must land as a visible message rather than a silent no-op.
 */
test.describe('Tournament — a call that clashes is refused, not delivered', () => {
  test('placing a match onto a held table or a held player is a 409, and the players hear nothing', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000)
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()

    const director = await guestFromContext(page.request)
    grantBetaTester(director.username)

    // Four entrants on two tables, with the reservation window TOMORROW: the go-live
    // solve places every fixture tomorrow, so nothing is imminent and nothing is
    // called by the solver. Every call in this spec is the director's own hand.
    const name = `Clash ${faker.string.alphanumeric(8)}`
    const { tournamentId, eventId, tables } = await seedTournament(director, name, {
      tables: TABLES,
    })
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

    const [a, b, c, d] = guests
    const readEvent = async () =>
      (await getScheduleDetail(director, tournamentId)).events.find(
        (e) => e.id === eventId,
      )!
    const seeded = await readEvent()
    const entryOf = (guest: Guest) => {
      const entrant = seeded.entrants.find((e) => e.username === guest.username)
      expect(entrant, `${guest.username} is entered`).toBeTruthy()
      return entrant!.id
    }
    const [entryA, entryB, entryC, entryD] = [a, b, c, d].map(entryOf)
    const f1 = fixtureBetween(seeded.fixtures, entryA, entryB)
    const f2 = fixtureBetween(seeded.fixtures, entryA, entryC)
    const f3 = fixtureBetween(seeded.fixtures, entryC, entryD)
    const [table1, table2] = tables

    // ----- the first call: A vs B onto Table 1, now -------------------------------
    await callFixture(director, tournamentId, f1.id, table1.id)
    const called = (await readEvent()).fixtures.find((f) => f.id === f1.id)!
    expect(called.pinned_at).not.toBeNull()
    expect(called.call_notified_count).toBe(1)
    expect(called.match_status).toBe('in_progress')
    await expect
      .poll(async () => noticesTitled(await listNotifications(a), CALLED).length, {
        timeout: 15_000,
      })
      .toBe(1)

    // ----- item 3: the same table AND a shared player → refused --------------------
    const sameTable = await placeFixtureRaw(director, tournamentId, f2.id, {
      table_id: table1.id,
      scheduled_start: naiveWallClock(new Date()),
    })
    expect(sameTable.status(), await sameTable.text()).toBe(409)
    const sameTableDetail = ((await sameTable.json()) as { detail: string }).detail
    expect(sameTableDetail).toContain(table1.label)
    expect(sameTableDetail).toMatch(/called there|already called/)

    // ----- item 3, other table: a shared player is still a clash -------------------
    const sharedPlayer = await placeFixtureRaw(director, tournamentId, f2.id, {
      table_id: table2.id,
      scheduled_start: naiveWallClock(new Date()),
    })
    expect(sharedPlayer.status(), await sharedPlayer.text()).toBe(409)
    const sharedPlayerDetail = ((await sharedPlayer.json()) as { detail: string })
      .detail
    expect(sharedPlayerDetail).toContain(a.username)
    expect(sharedPlayerDetail).toMatch(/already called/)

    // A refusal writes nothing: A vs C is still the solver's estimate, untold.
    const afterRefusals = await readEvent()
    const f2After = afterRefusals.fixtures.find((f) => f.id === f2.id)!
    expect(f2After.pinned_at).toBeNull()
    expect(f2After.call_notified_count).toBe(0)
    expect(f2After.match_status).toBe('pending')
    // ...and the promise it would have clashed with is untouched.
    const f1After = afterRefusals.fixtures.find((f) => f.id === f1.id)!
    expect(f1After.table_id).toBe(table1.id)
    expect(f1After.scheduled_start).toEqual(called.scheduled_start)
    expect(f1After.call_notified_count).toBe(1)

    // ----- item 1: the players were told once, and never corrected ----------------
    // Nobody was pinged by a refusal: A still holds exactly one call and no "moved";
    // C, who was never called, holds nothing at all.
    const feedA = await listNotifications(a)
    expect(noticesTitled(feedA, CALLED)).toHaveLength(1)
    expect(noticesTitled(feedA, MOVED)).toHaveLength(0)
    const feedC = await listNotifications(c)
    expect(noticesTitled(feedC, CALLED)).toHaveLength(0)
    expect(noticesTitled(feedC, MOVED)).toHaveLength(0)

    // ----- the director is the one who is warned: the Schedule tab ---------------
    // Move A vs C onto Table 1 from the board itself and confirm the call. The
    // refusal must reach the director as a message, and the editor must survive it.
    const detail = await TournamentDetailPage.navigateTo(page, tournamentId)
    const schedule = await detail.openSchedule()
    await expect(schedule.matchRow(f2.id)).toBeVisible({ timeout: 30_000 })
    await schedule.editPlacement(f2.id, table1, '09:30')
    await schedule.placeSave(f2.id).click()
    await expect(schedule.confirmCall).toBeVisible()
    await schedule.confirmCall.click()
    await expect(
      schedule.placementRefusal(/called there|already called/),
    ).toBeVisible({ timeout: 15_000 })
    await expect(schedule.placeEditor(f2.id)).toBeVisible()

    // Still nothing written, still nobody told.
    const f2Final = (await readEvent()).fixtures.find((f) => f.id === f2.id)!
    expect(f2Final.pinned_at).toBeNull()
    expect(f2Final.call_notified_count).toBe(0)
    expect(noticesTitled(await listNotifications(a), MOVED)).toHaveLength(0)
    expect(noticesTitled(await listNotifications(c), CALLED)).toHaveLength(0)

    // ----- a call that clashes with nothing still goes through -------------------
    // C vs D onto the free Table 2: different table, different humans — a 200, and
    // C is told exactly once. (D's feed would say the same.)
    const free = await placeFixtureRaw(director, tournamentId, f3.id, {
      table_id: table2.id,
      scheduled_start: naiveWallClock(new Date()),
    })
    expect(free.status(), await free.text()).toBe(200)
    await expect
      .poll(async () => noticesTitled(await listNotifications(c), CALLED).length, {
        timeout: 15_000,
      })
      .toBe(1)

    for (const guest of guests) await guest.ctx.dispose()
  })
})
