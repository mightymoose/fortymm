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

  form() {
    return screen.findByRole('form', { name: 'New match' })
  }

  // The card's "You": its text ("You", then the username when there is one).
  async you() {
    const form = await this.form()
    return within(form).getByText('You', { exact: true }).parentElement!
  }

  // The opponent's name.
  opponent() {
    return screen.findByRole('textbox', { name: 'Opponent' })
  }

  // The match's length: the radio "Best of `n`" (1, 3, 5 or 7).
  async bestOf(n: number) {
    const group = await screen.findByRole('radiogroup', {
      name: 'Match length',
    })
    return within(group).getByRole('radio', { name: `Best of ${n}` })
  }

  // The rated match switch.
  rated() {
    return screen.findByRole('switch', { name: 'Rated match' })
  }

  // "No opponent · unavailable" beside rated's label, or null.
  ratedUnavailable() {
    return screen.queryByText('No opponent · unavailable')
  }

  // The summary's first line ("Ready: You vs Ana").
  async summary() {
    const form = await this.form()
    return within(form).getByText(/^Ready:|^Name your opponent/)
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

  // "Discard changes?", when leaving a changed form, and its answers.
  discardDialog() {
    return screen.findByRole('dialog', { name: 'Discard changes?' })
  }

  queryDiscardDialog() {
    return screen.queryByRole('dialog', { name: 'Discard changes?' })
  }

  keepEditing() {
    return screen.findByRole('button', { name: 'Keep editing' })
  }

  discardAndLeave() {
    return screen.findByRole('button', { name: 'Discard & leave' })
  }
}
