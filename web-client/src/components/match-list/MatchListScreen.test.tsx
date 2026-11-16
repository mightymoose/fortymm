import userEvent from '@testing-library/user-event'
import { expect, test, vi } from 'vitest'
import type { MatchSummary } from '../../stores/matches.ts'
import { noNewVersion } from '../DeviceAlert.page.tsx'
import { MatchListScreenPage } from './MatchListScreen.page.tsx'

// The screen alone, with the props each state takes: matches as the match
// list store gives them. That the page shows the store's matches is
// MatchList.test.tsx and the route's test (src/routes/matches.test.tsx).

const first: MatchSummary = { matchId: 'm-1', bestOf: 5, rated: false }
const second: MatchSummary = { matchId: 'm-2', bestOf: 3, rated: true }
const third: MatchSummary = { matchId: 'm-3', bestOf: 7, rated: true }

test('each match is a row of its opponent, Anonymous, and its format, in the order given', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [third, first, second] })

  expect(await page.heading()).toBeVisible()
  const rows = await page.rows()
  expect(rows.map((row) => page.cells(row))).toEqual([
    ['You vs Anonymous', 'Best of 7 · Rated'],
    ['You vs Anonymous', 'Best of 5 · Unrated'],
    ['You vs Anonymous', 'Best of 3 · Rated'],
  ])
})

test('a match’s row links to its own page, /matches/<matchId>, and following it goes there', async () => {
  const user = userEvent.setup()
  const page = new MatchListScreenPage()
  page.render({ matches: [first, second] })

  const [firstRow, secondRow] = await page.rows()
  const link = page.matchLink(secondRow!)
  expect(link).toHaveAccessibleName('You vs Anonymous')
  expect(link).toHaveAttribute('href', '/matches/m-2')
  expect(page.matchLink(firstRow!)).toHaveAttribute('href', '/matches/m-1')
  await user.click(link)

  // The bare router follows it and the screen stays (render-screen.tsx):
  // the link it followed is now the current page.
  const [, followed] = await page.rows()
  expect(page.matchLink(followed!)).toHaveAttribute('aria-current', 'page')
})

test('with matches, New match beside the heading links to the new match screen, and there is no empty state', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [first] })
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

test('a list the device wouldn’t read says so under the heading, with no table, no empty state and no New match', async () => {
  const page = new MatchListScreenPage()
  page.renderUnavailable({
    reason: 'storage-unavailable',
    newVersion: noNewVersion,
    onRetry: async () => {},
  })

  expect(await page.heading()).toBeVisible()
  expect(await page.unavailable()).toHaveTextContent(
    'This browser isn’t letting FortyMM read its data.',
  )
  expect(page.tableNow()).toBeNull()
  expect(page.emptyStateNow()).toBeNull()
  expect(page.newMatchLinks()).toEqual([])
})

test('Try again reads the list again; refused again, the alert is shown anew', async () => {
  const user = userEvent.setup()
  let release = () => {}
  const onRetry = vi.fn(() => new Promise<void>((resolve) => (release = resolve)))
  const page = new MatchListScreenPage()
  page.renderUnavailable({ reason: 'core-unavailable', newVersion: noNewVersion, onRetry })
  const before = await page.unavailable()

  await user.click(await page.tryAgain())

  expect(onRetry).toHaveBeenCalledTimes(1)
  // While the read runs, the same alert stays.
  expect(page.unavailableNow()).toBe(before)
  release()
  await vi.waitFor(() => expect(page.unavailableNow()).not.toBe(before))
  expect(page.unavailableNow()).toHaveTextContent('Try again.')
  // The pressed button was remounted with its alert: focus is on the new one.
  expect(await page.tryAgain()).toHaveFocus()
})
