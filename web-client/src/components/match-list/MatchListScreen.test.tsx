import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import type { MatchSummary } from '../../stores/matches.ts'
import { MatchListScreenPage } from './MatchListScreen.page.tsx'

// The screen alone, with the props each state takes: matches as the match
// list store gives them. That the page shows the store's matches is
// MatchList.test.tsx and the route's test (src/routes/matches.test.tsx).

const ana: MatchSummary = { matchId: 'm-ana', opponentName: 'Ana', bestOf: 5, rated: false }
const ben: MatchSummary = { matchId: 'm-ben', opponentName: 'Ben', bestOf: 3, rated: true }
const chen: MatchSummary = { matchId: 'm-chen', opponentName: 'Chen', bestOf: 7, rated: true }

test('each match is a row of its opponent and its format, in the order given', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [chen, ana, ben] })

  expect(await page.heading()).toBeVisible()
  const rows = await page.rows()
  expect(rows.map((row) => page.cells(row))).toEqual([
    ['You vs Chen', 'Best of 7 · Rated'],
    ['You vs Ana', 'Best of 5 · Unrated'],
    ['You vs Ben', 'Best of 3 · Rated'],
  ])
})

test('a match with no opponent’s name is the row “You vs Anonymous”, linking to its own page', async () => {
  const page = new MatchListScreenPage()
  const anonymous: MatchSummary = { matchId: 'm-anon', opponentName: null, bestOf: 3, rated: false }
  page.render({ matches: [anonymous] })

  const [row] = await page.rows()
  expect(page.cells(row!)).toEqual(['You vs Anonymous', 'Best of 3 · Unrated'])
  expect(await page.matchLink('You vs Anonymous')).toHaveAttribute('href', '/matches/m-anon')
})

test('a match’s row links to its own page, /matches/<matchId>, and following it goes there', async () => {
  const user = userEvent.setup()
  const page = new MatchListScreenPage()
  page.render({ matches: [ana, ben] })

  const link = await page.matchLink('You vs Ben')
  expect(link).toHaveAttribute('href', '/matches/m-ben')
  expect(await page.matchLink('You vs Ana')).toHaveAttribute('href', '/matches/m-ana')
  await user.click(link)

  // The bare router follows it and the screen stays (render-screen.tsx):
  // the link it followed is now the current page.
  expect(await page.matchLink('You vs Ben')).toHaveAttribute('aria-current', 'page')
})

test('with matches, New match beside the heading links to the new match screen, and there is no empty state', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [ana] })
  await page.table()

  const links = page.newMatchLinks()
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/matches/new'])
  expect(page.emptyStateNow()).toBeNull()
})

test('with no matches, the empty state shows with its New match, a link to the new match screen, and there is no table', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [] })

  expect(await page.emptyState()).toBeVisible()
  const links = page.newMatchLinks()
  expect(links.map((link) => link.getAttribute('href'))).toEqual(['/matches/new'])
  expect(page.tableNow()).toBeNull()
})
