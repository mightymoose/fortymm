import { test, expect, type Page } from '@playwright/test'

import { PlayerProfilePage } from '../page-objects/player-profile.page'
import {
  findUserId,
  guestFromContext,
  mintGuest,
  playRatedMatch,
  type Guest,
} from '../support/match-api'
import { fetchDefaultLeague } from '../support/player-api'
import { ProfileRequests } from '../support/profile-requests'

/**
 * End-to-end coverage for the player profile (`/players/$userId`) — the two of
 * its behaviors that can only break in a real browser against a real backend
 * (ADR-0915), neither of which the component suite can honestly assert:
 *
 * 1. **The chart's range flip is a network contract.** The profile bundle embeds
 *    the window the chart paints first, so a first paint must cost *no*
 *    rating-history request at all; a range tab must then fire *exactly one*
 *    narrow request and *no* second bundle request, hold the old line on screen
 *    while it lands, and put the range in the URL where a reload will find it. A
 *    mocked unit test can only assert this against its own mock.
 *
 * 2. **The league lives in the URL.** `?league=` re-keys the bundle; a mangled
 *    one must degrade to the default league rather than reach the API (which
 *    would 422 it).
 *
 * ---
 *
 * ## What could NOT be seeded, and why (be suspicious of any test that claims it)
 *
 * **A league *switch* is not reachable on this stack.** Every user belongs to
 * exactly ONE league, and there is no way over the API to change that: the whole
 * codebase inserts a `league_memberships` row in exactly one place
 * (`add_user_to_default_league`, called when a user is minted), and there is no
 * league endpoint of any kind — no create, no join. `api/scripts/seed_leagues.py`
 * seeds the single default league at boot. So a second ladder to switch *to*
 * cannot be provisioned through the app's own surface, and reaching around it
 * (docker exec + psql) would both couple this suite to compose internals and
 * break the `E2E_BASE_URL` mode, where we don't own the stack.
 *
 * What that costs, precisely: the assertion that picking a *different* league
 * rebinds the rating half of the page (rating/rank/peak/confidence) while leaving
 * career alone is **not made here**. It is made in `api/tests/test_players.py`
 * (two leagues → two ratings, one career), where two ladders can be created
 * directly. What IS covered below is the browser half that the API tests cannot
 * see: the card renders the one ladder and marks it current, and the `?league=`
 * URL contract holds — including that a nonsense league never goes on the wire.
 *
 * The day a join-a-league endpoint lands, the missing test is one seed call away.
 */

/** The subject: a player with a decided **rated** match, so their rating chart
 * has a real line (two points — the `initial` rating every user is seeded, plus
 * the match) and a non-zero net change, rather than the flat line an unplayed
 * player draws. Returns the viewer (the browser's own guest) and the subject's id.
 *
 * Seeded per test, not in a `beforeAll`: the suite is `fullyParallel` against one
 * shared stack, and each test owns its own players.
 */
async function seedRatedPlayer(
  page: Page,
  baseURL: string,
): Promise<{ viewer: Guest; subject: Guest; subjectId: string }> {
  // The viewer is the browser's own session (`page.request` shares the page
  // context's cookie jar), so navigations run authenticated as them.
  const viewer = await guestFromContext(page.request)
  const subject = await mintGuest(baseURL)
  const subjectId = await findUserId(viewer, subject.username)
  // The viewer beats the subject 11–5 in a rated best-of-1; the subject accepts.
  // Both come out with a rating and a rating-history row.
  await playRatedMatch(viewer, subject, subjectId)
  return { viewer, subject, subjectId }
}

test.describe('Player profile — the chart is a network contract', () => {
  test('first paint draws the chart from the bundle: one bundle request, zero rating-history requests', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { subject, subjectId } = await seedRatedPlayer(page, baseURL!)

    const requests = new ProfileRequests(page, subjectId)
    const profile = await PlayerProfilePage.navigateTo(page, subjectId)

    // The page is painted...
    await expect(profile.playerName).toContainText(subject.username)
    // ...and the chart is *drawn*, from a window that actually has matches in it.
    // This assertion is the vacuity guard for the two counts below: "zero
    // rating-history requests" is trivially true of a chart that never rendered,
    // and "over the last 90 days" (rather than "No rated matches in the last 90
    // days") is what distinguishes a seeded line from an empty one.
    await expect(profile.chartLine).toBeVisible()
    await expect(profile.chartLine).toHaveAttribute(
      'aria-label',
      /over the last 90 days/,
    )

    // The whole point of the BFF embedding the window: the chart's cache is
    // seeded by the bundle's own fetch, so it never asks for its own data.
    expect(
      requests.history,
      'first paint must not fetch rating history — the bundle carries it',
    ).toHaveLength(0)
    // And the seven cards share one cache entry: one request, not seven (and not
    // two — the route loader must prefetch the same key the cards ask for).
    expect(requests.bundle, 'the profile is ONE bundle request').toHaveLength(1)
  })

  test('a range flip fetches only that range, keeps the old line on screen, and survives a reload', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { subjectId } = await seedRatedPlayer(page, baseURL!)

    const requests = new ProfileRequests(page, subjectId)
    const profile = await PlayerProfilePage.navigateTo(page, subjectId)
    await expect(profile.chartLine).toHaveAttribute(
      'aria-label',
      /over the last 90 days/,
    )

    // Hold the next rating-history response until we've looked at the page
    // mid-flight. Without this gate the in-flight state is a race we'd have to
    // guess at; with it, "the old chart is still on screen while the new range
    // loads" is a deterministic assertion.
    const historyPattern = `**/api/v1/players/${subjectId}/rating-history*`
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await page.route(historyPattern, async (route) => {
      await gate
      await route.continue()
    })

    // Everything from here is measured on the flip alone.
    requests.reset()
    // 30d, deliberately NOT 90d: the default window is the one the bundle seeded,
    // so flipping *to* it is a cache hit and would fire no request at all —
    // inverting the assertion this test exists to make.
    await profile.rangeTab('30d').click()

    // The selection is the URL.
    await expect(page).toHaveURL(/[?&]range=30d/)

    // Mid-flight: the card is honest about what it is waiting for, the previous
    // line is STILL DRAWN (keepPreviousData), and the cold skeleton — which would
    // mean the chart blanked — never appears.
    await expect(profile.chartSummary).toContainText('Loading the last 30 days')
    await expect(profile.chartLine).toBeVisible()
    await expect(profile.chartSkeleton).toHaveCount(0)

    release()

    // Settled on the new window.
    await expect(profile.chartLine).toHaveAttribute(
      'aria-label',
      /over the last 30 days/,
    )
    await expect(profile.rangeTab('30d')).toHaveAttribute('aria-current', 'page')

    // The assertion no unit test can make honestly: ONE narrow request for the
    // range, and NOT ONE re-fetch of the bundle. A range flip that re-keyed the
    // bundle would re-suspend all six of the other cards — and would show up
    // right here.
    expect(requests.history, 'a range flip is one narrow request').toHaveLength(1)
    expect(requests.historyRanges()).toEqual(['30d'])
    expect(
      requests.bundle,
      'a range flip must not refetch the profile bundle',
    ).toHaveLength(0)

    // A reload lands back on 30d — the URL was the state all along. And the
    // bundle carries `?range=30d` on the way in, so it seeds the chart for the
    // *selected* window: still no rating-history request of its own.
    await page.unroute(historyPattern)
    requests.reset()
    await page.reload()

    const reloaded = PlayerProfilePage.current(page, subjectId)
    await expect(reloaded.chartLine).toHaveAttribute(
      'aria-label',
      /over the last 30 days/,
    )
    await expect(reloaded.rangeTab('30d')).toHaveAttribute(
      'aria-current',
      'page',
    )
    expect(requests.bundle).toHaveLength(1)
    expect(
      requests.history,
      'a reload into ?range=30d is still seeded by the bundle',
    ).toHaveLength(0)
  })

  test('a failed range flip fails inside the chart card, and the rest of the profile stays painted', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { subject, subjectId } = await seedRatedPlayer(page, baseURL!)

    const profile = await PlayerProfilePage.navigateTo(page, subjectId)
    await expect(profile.chartLine).toBeVisible()

    // The next window's request fails.
    const historyPattern = `**/api/v1/players/${subjectId}/rating-history*`
    await page.route(historyPattern, (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'boom' }),
      }),
    )

    await profile.rangeTab('1y').click()

    // The failure renders where the picture goes, with a retry beside it...
    await expect(profile.chartError).toBeVisible()
    await expect(profile.chartError).toContainText('load that range')
    await expect(profile.chartRetry).toBeVisible()

    // ...and the rest of the profile is untouched. This is the half that the
    // chart's `useQuery` (rather than `useSuspenseQuery`) buys: the six
    // bundle-backed cards share a `throwOnError` query, so if the chart threw,
    // the route's error boundary would have eaten the whole page.
    await expect(profile.playerName).toContainText(subject.username)
    await expect(profile.career).toBeVisible()
    await expect(profile.leagues).toBeVisible()

    // Retry, with the API healthy again, recovers in place.
    await page.unroute(historyPattern)
    await profile.chartRetry.click()
    await expect(profile.chartError).toHaveCount(0)
    await expect(profile.chartLine).toHaveAttribute(
      'aria-label',
      /over the last year/,
    )
  })
})

test.describe('Player profile — the league lives in the URL', () => {
  test('the Leagues card shows the one ladder the player is on, and marks it current', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { subjectId } = await seedRatedPlayer(page, baseURL!)

    const profile = await PlayerProfilePage.navigateTo(page, subjectId)

    // Exactly one row, because every player is in exactly one league and there is
    // no way to join a second (see the note at the top of this file). The card
    // still renders — hiding it for a single-league player would delete the only
    // affordance that makes the page legible the day a second ladder lands.
    await expect(profile.leagueRows).toHaveCount(1)
    await expect(profile.leagueRows.first()).toContainText('FortyMM')
    await expect(profile.leagueRows.first()).toContainText('Default')
    // Exactly one row is current, always.
    await expect(profile.selectedLeagueRow).toHaveCount(1)
  })

  test('a mangled ?league= degrades to the default league and never reaches the API', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { subject, subjectId } = await seedRatedPlayer(page, baseURL!)

    const requests = new ProfileRequests(page, subjectId)
    await PlayerProfilePage.navigateTo(page, subjectId, { league: 'not-a-uuid' })
    const profile = PlayerProfilePage.current(page, subjectId)

    // A broken URL is not a broken app: the route's Zod `.catch(undefined)` drops
    // the garbage and the page renders the default league.
    await expect(profile.playerName).toContainText(subject.username)
    await expect(profile.chartLine).toBeVisible()
    await expect(profile.selectedLeagueRow).toHaveCount(1)

    // And — the browser-only half — the nonsense value never goes on the wire.
    // `league_id` is a `uuid.UUID` on the API, so a request carrying "not-a-uuid"
    // would 422 and throw the whole profile to its error boundary. Parsing at the
    // route boundary is what stops it ever being asked.
    expect(requests.bundle.length).toBeGreaterThan(0)
    expect(
      requests.bundleLeagueIds().filter((id) => id !== null),
      'a mangled ?league= must not be put on the wire',
    ).toEqual([])
  })

  test('an explicit ?league= is honoured on the wire and survives a reload', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL, 'baseURL must be set for the API seed').toBeTruthy()
    const { viewer, subjectId } = await seedRatedPlayer(page, baseURL!)

    // NOTE: this is the *default* league — the only one that exists. So this
    // covers the `?league=` URL contract (the param is parsed, put on the wire,
    // and survives a reload) but NOT a switch between two ladders, which cannot
    // be seeded here. Career-equality below is likewise a weak claim with one
    // league: the strong version (two ladders, two ratings, one career) lives in
    // `api/tests/test_players.py`.
    const league = await fetchDefaultLeague(viewer, subjectId)

    // The career figure as the clean URL renders it — the number `?league=` must
    // not move.
    const clean = await PlayerProfilePage.navigateTo(page, subjectId)
    await expect(clean.careerTotal).toBeVisible()
    const careerBefore = await clean.careerTotal.innerText()

    const requests = new ProfileRequests(page, subjectId)
    const profile = await PlayerProfilePage.navigateTo(page, subjectId, {
      league: league.id,
    })

    await expect(profile.chartLine).toBeVisible()
    await expect(profile.selectedLeagueRow).toContainText(league.name)
    // The league the URL named is the league the bundle asked the API for.
    expect(requests.bundleLeagueIds()).toEqual([league.id])
    // Career is cross-league: naming a ladder does not move it.
    await expect(profile.careerTotal).toHaveText(careerBefore)

    // A reload keeps the selection — the URL is the state.
    await page.reload()
    const reloaded = PlayerProfilePage.current(page, subjectId)
    await expect(page).toHaveURL(new RegExp(`[?&]league=${league.id}`))
    await expect(reloaded.selectedLeagueRow).toContainText(league.name)
    await expect(reloaded.careerTotal).toHaveText(careerBefore)
  })
})
