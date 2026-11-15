import userEvent from '@testing-library/user-event'
import { expect, test } from 'vitest'
import type { ListedMatch } from './MatchListScreen.tsx'
import { MatchListScreenPage } from './MatchListScreen.page.tsx'

const matchLink = (id: string) => `/matches/${id}`

const ana: ListedMatch = {
  id: 'm-ana',
  opponent: 'Ana',
  bestOf: 5,
  rated: false,
  startedAt: new Date('2026-11-14T17:00:00Z'),
  games: { you: 2, them: 1 },
  finished: false,
}
const ben: ListedMatch = {
  id: 'm-ben',
  opponent: 'Ben',
  bestOf: 3,
  rated: true,
  startedAt: new Date('2026-11-13T19:30:00Z'),
  games: { you: 2, them: 0 },
  finished: true,
}
const chen: ListedMatch = {
  id: 'm-chen',
  opponent: 'Chen',
  bestOf: 7,
  rated: true,
  startedAt: new Date('2026-11-12T09:00:00Z'),
  games: { you: 1, them: 4 },
  finished: true,
}

test('each match is a row of its opponent, its format, its state and the score in games', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [ana, ben, chen], matchLink })

  expect(await page.heading()).toBeVisible()
  const rows = await page.rows()
  expect(rows.map((row) => page.cells(row))).toEqual([
    ['You vs Ana', 'Best of 5 · Unrated', 'In progress · Game 4 next', '2 – 1'],
    ['You vs Ben', 'Best of 3 · Rated', 'Finished · You won', '2 – 0'],
    ['You vs Chen', 'Best of 7 · Rated', 'Finished · Chen won', '1 – 4'],
  ])
})

test('a match with no games yet is in progress, game 1 next, at 0 – 0', async () => {
  const page = new MatchListScreenPage()
  page.render({
    matches: [{ ...ana, games: { you: 0, them: 0 } }],
    matchLink,
  })

  const [row] = await page.rows()
  expect(page.cells(row!)).toEqual([
    'You vs Ana',
    'Best of 5 · Unrated',
    'In progress · Game 1 next',
    '0 – 0',
  ])
})

test('the matches show newest first, whatever order they are given in', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [chen, ana, ben], matchLink })

  const rows = await page.rows()
  expect(rows.map((row) => page.cells(row)[0])).toEqual([
    'You vs Ana',
    'You vs Ben',
    'You vs Chen',
  ])
})

test('a match’s row links to its own page, the address matchLink gives for its id, and following it goes there', async () => {
  const user = userEvent.setup()
  const page = new MatchListScreenPage()
  page.render({ matches: [ana, ben], matchLink })

  const link = await page.matchLink('You vs Ben')
  expect(link).toHaveAttribute('href', '/matches/m-ben')
  expect(await page.matchLink('You vs Ana')).toHaveAttribute(
    'href',
    '/matches/m-ana',
  )
  await user.click(link)

  // The bare router follows it and the screen stays (render-screen.tsx):
  // the link it followed is now the current page.
  expect(await page.matchLink('You vs Ben')).toHaveAttribute(
    'aria-current',
    'page',
  )
})

test('with matches, New match beside the heading links to the new match screen, and there is no empty state', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [ana], matchLink })
  await page.table()

  const links = page.newMatchLinks()
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/matches/new',
  ])
  expect(page.emptyStateNow()).toBeNull()
})

test('with no matches, the empty state shows with its New match, a link to the new match screen, and there is no table', async () => {
  const page = new MatchListScreenPage()
  page.render({ matches: [], matchLink })

  expect(await page.emptyState()).toBeVisible()
  const links = page.newMatchLinks()
  expect(links.map((link) => link.getAttribute('href'))).toEqual([
    '/matches/new',
  ])
  expect(page.tableNow()).toBeNull()
})
