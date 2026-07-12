import { expect, test } from '@playwright/test'
import { NewMatchPage } from './page-objects/matches/new-match.page'

// Stable, explicit ids so DOM-order and request-body assertions can name them.
const ADA = { id: 'pl-ada', username: 'ada.lovelace' }
const GRACE = { id: 'pl-grace', username: 'grace.hopper' }
const LINUS = { id: 'pl-linus', username: 'linus.torvalds' }
const MARGARET = { id: 'pl-margaret', username: 'margaret.hamilton' }

const ROSTER = [ADA, GRACE, LINUS, MARGARET]

// Successful match creation navigates to the new match's `current_game`
// scoring URL — both ids are server-assigned, so this matches any non-empty
// segment.
const SCORING_URL = /\/matches\/[^/]+\/games\/[^/]+\/scores\/new$/

test.describe('Opponent picker — recent opponents', () => {
  test('shows a skeleton while recent opponents load, then the chips', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, {
      players: ROSTER,
      // Held long enough that the skeleton is reliably observable.
      recentDelayMs: 2000,
    })

    await expect(nm.recentSkeleton).toBeVisible()
    // The delayed response lands and the real chips replace the placeholder.
    await expect(nm.playerChip(ADA.username)).toBeVisible()
    await expect(nm.recentSkeleton).toBeHidden()
  })

  test('renders recent opponents in the order the endpoint returns them', async ({
    page,
  }) => {
    // The endpoint ranks opponents by recency; the client must preserve that
    // order rather than re-sorting (the old picker was alphabetical).
    const nm = await NewMatchPage.open(page, {
      players: ROSTER,
      recentOpponents: [LINUS, ADA, MARGARET, GRACE],
    })

    await expect(nm.playerChip(LINUS.username)).toBeVisible()
    const names = await page.locator('.nm-chip .n').allTextContents()
    expect(names).toEqual([
      LINUS.username,
      ADA.username,
      MARGARET.username,
      GRACE.username,
    ])
  })

  test('shows an empty state but keeps search when the caller has no opponents yet (#167)', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: [] })

    await expect(nm.emptyPlayers).toBeVisible()
    // An empty grid no longer means an empty roster — search is the way to
    // find a first opponent, so it stays reachable.
    await expect(nm.searchAllButton).toBeVisible()
  })

  test('surfaces a retry button when recent opponents fail to load', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, {
      players: ROSTER,
      failRecent: { status: 500, detail: 'database unavailable' },
    })

    await expect(nm.pickerError).toBeVisible()
    await expect(nm.pickerError).toContainText(/couldn.t load players/i)

    // The queued failure is consumed by the first request, so retry recovers.
    await nm.pickerRetry.click()
    await expect(nm.playerChip(ADA.username)).toBeVisible()
    await expect(nm.pickerError).toBeHidden()
  })

  test('still lets the player start a solo match after a failed recent load', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, {
      players: ROSTER,
      failRecent: { status: 500 },
    })

    await expect(nm.pickerError).toBeVisible()
    // The picker boundary swallows the failed players request but the form's
    // Start button still works — submitting without picking creates a solo,
    // unrated match.
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: null, best_of: 5, rated: false },
    ])
  })
})

test.describe('Opponent picker — search', () => {
  test('opens to a hint and fires no request until the player types', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await expect(nm.searchHint).toBeVisible()
    // An empty search box never hits the network — no fetch-all-and-filter.
    expect(nm.store.searchQueries).toHaveLength(0)
  })

  test('searches the dedicated endpoint and selects a server-side result', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await nm.search('hamilton')
    await nm.searchResult(MARGARET.username).click()

    await expect(nm.selectedOpponentName).toHaveText(MARGARET.username)
    // The typed term reached the endpoint — nothing was filtered client-side.
    expect(nm.store.searchQueries).toContain('hamilton')

    await nm.start()
    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: MARGARET.id, best_of: 5, rated: false },
    ])
  })

  test('a matching result is not highlighted or announced as selected until the user says so (#894)', async ({
    page,
  }) => {
    // The other half of the launch-blocker: typing "hamilton" lit the one
    // matching row up exactly like a hover — and told screen readers it was
    // `aria-selected` — while the card above still said "solo match".
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await nm.search('hamilton')
    await expect(nm.searchResult(MARGARET.username)).toBeVisible()

    // Nothing has been chosen, so nothing looks or reads as chosen.
    await expect(page.locator('.nm-item.active')).toHaveCount(0)
    await expect(page.locator('.nm-item[aria-selected="true"]')).toHaveCount(0)
    await expect(nm.summaryTop).toContainText(/no opponent selected/i)

    // Arrowing to the row highlights it — and still does not claim it is chosen.
    await page.keyboard.press('ArrowDown')
    await expect(page.locator('.nm-item.active')).toHaveCount(1)
    await expect(page.locator('.nm-item[aria-selected="true"]')).toHaveCount(0)

    // Enter is what commits it.
    await page.keyboard.press('Enter')
    await expect(nm.selectedOpponentName).toHaveText(MARGARET.username)
  })

  test('shows a no-match message for an unknown name', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await nm.search('nobody-here')

    await expect(nm.searchNoMatch).toBeVisible()
  })

  test('a search that matches nobody reads as unresolved, not as a ready solo match (#893)', async ({
    page,
  }) => {
    // The launch-blocker, in the browser where it was found: a user hunting for
    // an opponent typed a name, found nobody, and the card still said "Ready:
    // You · solo match" over a button that said "Start match" — so pressing it
    // silently created a solo match they never asked for.
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    // An empty search box is not a hunt in progress — solo is still the honest
    // default and nothing is relabelled.
    await expect(nm.startButton).toBeVisible()

    await nm.search('zzzzzz')
    await expect(nm.searchNoMatch).toBeVisible()

    // Now it is: the summary stops claiming readiness, and the button says what
    // pressing it would actually do. It stays enabled — a solo match is a fine
    // thing to want, it just must not be a surprise.
    await expect(nm.summaryTop).toContainText(/no opponent selected/i)
    await expect(nm.summaryTop).not.toContainText(/ready/i)
    await expect(nm.soloStartButton).toBeEnabled()
    await expect(nm.startButton).toBeHidden()

    // Committing to someone resolves it, leftover query and all.
    await nm.search('hamilton')
    await nm.searchResult(MARGARET.username).click()
    await expect(nm.selectedOpponentName).toHaveText(MARGARET.username)
    await expect(nm.startButton).toBeVisible()
    await expect(nm.soloStartButton).toBeHidden()
  })

  test('offers a visible way back to the recent opponents, and takes it (#895)', async ({
    page,
  }) => {
    // Entering search used to be one-way: the recent chips vanished and neither
    // clearing the box nor Escape brought them back. Recents are the fastest
    // path to a rematch, so losing them made setup feel sticky.
    const nm = await NewMatchPage.open(page, {
      players: ROSTER,
      recentOpponents: [ADA, GRACE],
    })

    await expect(nm.playerChip(ADA.username)).toBeVisible()
    await expect(nm.backToRecentButton).toBeHidden()

    await nm.openSearch()
    await nm.search('zzzzzz')
    await expect(nm.searchNoMatch).toBeVisible()
    // Mid-hunt, the card reads as `seeking` (#893).
    await expect(nm.soloStartButton).toBeVisible()

    await nm.backToRecent()

    // The grid is back, and so is the affordance that opened search.
    await expect(nm.playerChip(ADA.username)).toBeVisible()
    await expect(nm.playerChip(GRACE.username)).toBeVisible()
    await expect(nm.searchAllButton).toBeVisible()
    await expect(nm.backToRecentButton).toBeHidden()

    // Abandoning the hunt is not a decision to play alone: the card drops back
    // to `none`, so the button stops threatening a solo match (#893 × #895).
    await expect(nm.startButton).toBeVisible()
    await expect(nm.soloStartButton).toBeHidden()
    await expect(nm.summaryTop).not.toContainText(/no opponent selected/i)

    // And the recovered grid is live — one click and the rematch is set up.
    await nm.pickPlayer(GRACE.username)
    await expect(nm.selectedOpponentName).toHaveText(GRACE.username)
  })

  test('search still works after a trip back to the recent opponents (#895)', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await nm.search('hamilton')
    await expect(nm.searchResult(MARGARET.username)).toBeVisible()

    await nm.backToRecent()
    await expect(nm.playerChip(ADA.username)).toBeVisible()

    // Re-entering search opens a clean box — the abandoned query does not come
    // back with it — and the pick still commits.
    await nm.openSearch()
    await expect(nm.searchHint).toBeVisible()
    await nm.search('hamilton')
    await nm.searchResult(MARGARET.username).click()
    await expect(nm.selectedOpponentName).toHaveText(MARGARET.username)

    await nm.start()
    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: MARGARET.id, best_of: 5, rated: false },
    ])
  })

  test('leaves a failed search behind instead of trapping the player in it (#895)', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })
    nm.store.failNextSearch({ status: 500, detail: 'search unavailable' })

    await nm.openSearch()
    await nm.search('ada')
    await expect(nm.pickerError).toBeVisible()

    // "Try again" is not the only exit from a broken search — the way back to
    // recents survives the error fallback, and leaving clears it.
    await nm.backToRecent()

    await expect(nm.pickerError).toBeHidden()
    await expect(nm.playerChip(ADA.username)).toBeVisible()
  })

  test('surfaces the error boundary when a search request fails', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })
    nm.store.failNextSearch({ status: 500, detail: 'search unavailable' })

    await nm.openSearch()
    await nm.search('ada')

    await expect(nm.pickerError).toBeVisible()
    await expect(nm.pickerError).toContainText(/couldn.t load players/i)
  })
})
