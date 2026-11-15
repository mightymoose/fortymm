import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import { MatchListScreen, type MatchListScreenProps } from './MatchListScreen.tsx'

// The matches list (MatchListScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/matches.test.tsx) too.
export class MatchListScreenPage {
  render(props: MatchListScreenProps) {
    return renderScreen(<MatchListScreen {...props} />, { path: '/matches' })
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'Matches' })
  }

  // The table of matches.
  table() {
    return screen.findByRole('table', { name: 'Matches' })
  }

  // The table, or null if there is none now.
  tableNow() {
    return screen.queryByRole('table', { name: 'Matches' })
  }

  // Its matches' rows, in order (the header row left out).
  async rows() {
    const [, body] = within(await this.table()).getAllByRole('rowgroup')
    return within(body!).getAllByRole('row')
  }

  // A row's cells' text, in order: opponent, format.
  cells(row: HTMLElement) {
    return within(row)
      .getAllByRole('cell')
      .map((cell) => cell.textContent)
  }

  // The link to a match's page, by its name ("You vs Ana").
  matchLink(name: string) {
    return screen.findByRole('link', { name })
  }

  // The empty state's title, with no matches.
  emptyState() {
    return screen.findByText('No matches yet.')
  }

  // The empty state's title, or null if it isn't shown now.
  emptyStateNow() {
    return screen.queryByText('No matches yet.')
  }

  // Every "New match" link outside a navigation (the bottom bar has one of
  // the same name where the layout is mounted): beside the heading, or in
  // the empty state.
  newMatchLinks() {
    const links = screen.queryAllByRole('link', { name: 'New match' })
    return links.filter((link) => link.closest('nav') === null)
  }
}
