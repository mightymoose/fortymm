import { expect, test } from '@playwright/test'
import { NewMatchPage } from './page-objects/matches/new-match.page'
import { CREATOR_USERNAME } from './page-objects/matches/match-store'

// Successful match creation navigates to the new match's `current_game`
// scoring URL — both ids are server-assigned, so this matches any non-empty
// segment.
const SCORING_URL = /\/matches\/[^/]+\/games\/[^/]+\/scores\/new$/

// Stable, explicit ids so request-body assertions can name them.
const ADA = { id: 'pl-ada', username: 'ada.lovelace' }
const GRACE = { id: 'pl-grace', username: 'grace.hopper' }
const LINUS = { id: 'pl-linus', username: 'linus.torvalds' }

const ROSTER = [ADA, GRACE, LINUS]

// A roster with one player (Barbara) past the six the recent grid features,
// so the typeahead test proves search reaches the whole roster server-side,
// not just the chips already on screen.
const BARBARA = { id: 'pl-barbara', username: 'barbara.liskov' }
const BIG_ROSTER = [
  ADA,
  GRACE,
  LINUS,
  { id: 'pl-margaret', username: 'margaret.hamilton' },
  { id: 'pl-katherine', username: 'katherine.johnson' },
  { id: 'pl-radia', username: 'radia.perlman' },
  BARBARA,
]

test.describe('New match — page', () => {
  test('renders the setup card for the signed-in player', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await expect(nm.heading).toBeVisible()
    await expect(nm.youName).toHaveText(CREATOR_USERNAME)
    await expect(nm.startButton).toBeEnabled()
    // Rated is on by default before an opponent is chosen.
    await expect(nm.ratedSwitch).toBeChecked()
  })

  test('lists the registered players in the picker', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    for (const player of ROSTER) {
      await expect(nm.playerChip(player.username)).toBeVisible()
    }
  })

  test('shows an empty state when there are no other players', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: [] })

    await expect(nm.emptyPlayers).toBeVisible()
  })
})

test.describe('New match — validation', () => {
  test('blocks a rated match with no opponent and sends no request', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.start()

    await expect(nm.error).toHaveText(/rated match needs an opponent/i)
    await expect(page).toHaveURL(/\/matches\/new$/)
    expect(nm.store.createdMatches).toHaveLength(0)
  })
})

test.describe('New match — creating a match', () => {
  test('creates a rated match against a registered opponent', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.pickPlayer(GRACE.username)
    await expect(nm.selectedOpponentName).toHaveText(GRACE.username)
    await expect(nm.summaryTop).toContainText('You vs')
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: GRACE.id, best_of: 5, rated: true },
    ])
  })

  test('respects the chosen match length', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.pickPlayer(ADA.username)
    await nm.setBestOf(7)
    await expect(nm.bestOfOption(7)).toHaveAttribute('aria-checked', 'true')
    await expect(nm.summarySub).toContainText('Best of 7 · first to 4')
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: ADA.id, best_of: 7, rated: true },
    ])
  })

  test('creates an unrated match when Rated is toggled off', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.pickPlayer(ADA.username)
    await nm.toggleRated()
    await expect(nm.ratedSwitch).not.toBeChecked()
    await expect(nm.summarySub).toContainText('Unrated')
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: ADA.id, best_of: 5, rated: false },
    ])
  })

  test('starts a single-sided unrated match without an opponent', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.startWithoutOpponent()
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: null, best_of: 5, rated: false },
    ])
  })

  test('forces a guest match unrated regardless of the toggle', async ({
    page,
  }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.addGuest()
    // A guest can't be rated, so the switch is disabled and off.
    await expect(nm.ratedSwitch).toBeDisabled()
    await expect(nm.ratedSwitch).not.toBeChecked()
    await expect(nm.summarySub).toContainText('Unrated')
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: null, best_of: 5, rated: false },
    ])
  })
})

test.describe('New match — picking an opponent', () => {
  test('swaps the opponent via Change', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.pickPlayer(ADA.username)
    await expect(nm.selectedOpponentName).toHaveText(ADA.username)

    await nm.changeOpponent()
    await nm.pickPlayer(LINUS.username)
    await expect(nm.selectedOpponentName).toHaveText(LINUS.username)

    await nm.start()
    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: LINUS.id, best_of: 5, rated: true },
    ])
  })

  test('finds a player through typeahead search', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: BIG_ROSTER })

    await nm.openSearch()
    await nm.search('liskov')
    await nm.searchResult(BARBARA.username).click()

    await expect(nm.selectedOpponentName).toHaveText(BARBARA.username)
    await nm.start()

    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toEqual([
      { opponent_user_id: BARBARA.id, best_of: 5, rated: true },
    ])
  })
})

test.describe('New match — error handling', () => {
  test('surfaces the API error detail inline', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })
    nm.store.failNextCreate({ status: 404, detail: 'opponent not found' })

    await nm.pickPlayer(GRACE.username)
    await nm.start()

    await expect(nm.error).toHaveText(/opponent not found/i)
    // The failed create leaves the player on the form, not the dashboard.
    await expect(page).toHaveURL(/\/matches\/new$/)
  })

  test('lets the player retry after a failed create', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })
    nm.store.failNextCreate({ status: 500, detail: 'database unavailable' })

    await nm.pickPlayer(GRACE.username)
    await nm.start()
    await expect(nm.error).toHaveText(/database unavailable/i)

    // Only the first create was queued to fail — the retry goes through.
    await nm.start()
    await expect(page).toHaveURL(SCORING_URL)
    expect(nm.store.createdMatches).toHaveLength(2)
  })
})

test.describe('New match — navigation', () => {
  test('Cancel returns to the dashboard', async ({ page }) => {
    const nm = await NewMatchPage.open(page, { players: ROSTER })

    await nm.cancelButton.click()

    await expect(page).toHaveURL(/\/dashboard$/)
    expect(nm.store.createdMatches).toHaveLength(0)
  })
})
