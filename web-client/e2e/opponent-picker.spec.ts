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

  test('shows an empty state and hides search when nobody else exists', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: [] })

    await expect(nm.emptyPlayers).toBeVisible()
    await expect(nm.searchAllButton).toBeHidden()
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

  test('shows a no-match message for an unknown name', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.openSearch()
    await nm.search('nobody-here')

    await expect(nm.searchNoMatch).toBeVisible()
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
