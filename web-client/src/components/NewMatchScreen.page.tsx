import { screen, within } from '@testing-library/react'
import { renderScreen } from '../test/render-screen.tsx'
import { NewMatchScreen } from './NewMatchScreen.tsx'

// The new match screen (NewMatchScreen.tsx): how to render it alone, and
// what a person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/matches/new.test.tsx) too.
export class NewMatchScreenPage {
  render(props: Parameters<typeof NewMatchScreen>[0]) {
    return renderScreen(<NewMatchScreen {...props} />, { path: '/matches/new' })
  }

  heading() {
    return screen.findByRole('heading', { level: 1, name: 'New match' })
  }

  // The breadcrumbs above the heading, and their link back to the
  // dashboard.
  async breadcrumbToDashboard() {
    const crumbs = await screen.findByRole('navigation', { name: 'Breadcrumb' })
    return within(crumbs).getByRole('link', { name: 'Dashboard' })
  }

  form() {
    return screen.findByRole('form', { name: 'New match' })
  }

  // The opponent's name.
  opponent() {
    return screen.findByRole('textbox', { name: 'Opponent' })
  }

  // How many games, at most: the "Best of" radio for `n` (1, 3, 5 or 7).
  async bestOf(n: number) {
    const group = await screen.findByRole('radiogroup', { name: 'Best of' })
    return within(group).getByRole('radio', { name: String(n) })
  }

  // The points a game is played to: the radio for `n` (11 or 21).
  async points(n: number) {
    const group = await screen.findByRole('radiogroup', {
      name: 'Points per game',
    })
    return within(group).getByRole('radio', { name: String(n) })
  }

  startMatch() {
    return screen.findByRole('button', { name: 'Start match' })
  }

  cancel() {
    return screen.findByRole('link', { name: 'Cancel' })
  }

  // The error under the opponent's field, by its text, or null.
  opponentError() {
    return screen.queryByText('Enter your opponent’s name.')
  }
}
