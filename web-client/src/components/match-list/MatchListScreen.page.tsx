import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import {
  MatchListScreen,
  MatchListScreenUnavailable,
  type MatchListScreenProps,
} from './MatchListScreen.tsx'

// The matches list (MatchListScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/matches.test.tsx) too.
export class MatchListScreenPage {
  render(props: MatchListScreenProps) {
    return renderScreen(<MatchListScreen {...props} />, { path: '/matches' })
  }

  // The list the device wouldn't read (MatchListScreenUnavailable).
  renderUnavailable(props: Parameters<typeof MatchListScreenUnavailable>[0]) {
    return renderScreen(<MatchListScreenUnavailable {...props} />, { path: '/matches' })
  }

  // The alert that says the list couldn't be loaded, and its Try again.
  unavailable() {
    return screen.findByRole('alert', { name: 'Couldn’t load your matches' })
  }

  unavailableNow() {
    return screen.queryByRole('alert', { name: 'Couldn’t load your matches' })
  }

  tryAgain() {
    return screen.findByRole('button', { name: 'Try again' })
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

  // The link to a match's page, in its row. Every row's link has the same
  // name ("You vs Anonymous"), so a match is found by its row.
  matchLink(row: HTMLElement) {
    return within(row).getByRole('link')
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
