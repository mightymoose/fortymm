import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
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

  // The opponent's name.
  opponent() {
    return screen.findByRole('textbox', { name: 'Opponent’s name' })
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

  // The summary's first line ("Ready: You vs Ana", "Ready: You vs
  // Anonymous").
  async summary() {
    const form = await this.form()
    return within(form).getByText(/^Ready:/)
  }

  startMatch() {
    return screen.findByRole('button', { name: 'Start match' })
  }

  cancel() {
    return screen.findByRole('link', { name: 'Cancel' })
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
