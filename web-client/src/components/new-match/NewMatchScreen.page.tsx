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

  // Every text field in the form, by any name (the form has none).
  async textboxes() {
    return within(await this.form()).queryAllByRole('textbox')
  }

  // Every on/off control in the form, switch or checkbox, by any name (the
  // form has none: no match is rated).
  async toggles() {
    const form = within(await this.form())
    return [...form.queryAllByRole('switch'), ...form.queryAllByRole('checkbox')]
  }

  // The match's length: the radio "Best of `n`" (1, 3, 5 or 7).
  async bestOf(n: number) {
    const group = await screen.findByRole('radiogroup', {
      name: 'Match length',
    })
    return within(group).getByRole('radio', { name: `Best of ${n}` })
  }

  // The summary's first line ("Ready: You vs Anonymous").
  async summary() {
    const form = await this.form()
    return within(form).getByText(/^Ready:/)
  }

  // The summary's second line: the length, "Unrated", the game's rules.
  async summaryDetails() {
    const form = await this.form()
    return within(form).getByText(/games to 11, win by 2$/)
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
