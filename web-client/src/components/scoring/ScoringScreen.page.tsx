import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import type { BestOf, Games } from '../../scoring/scoring.ts'
import { Match } from './ScoringScreen.match.tsx'
import { ScoringScreen, type ScoringScreenProps } from './ScoringScreen.tsx'

// The scoring screen (ScoringScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted.
export class ScoringScreenPage {
  // With `browserHistory`, the screen's leave guard answers the window's
  // beforeunload (renderScreen).
  render(props: ScoringScreenProps, { browserHistory = false } = {}) {
    return renderScreen(<ScoringScreen {...props} />, { path: '/scoring', browserHistory })
  }

  // What the device refused of the last save or clear: the named alert
  // (DeviceAlert; the form's error line is an alert too, unnamed).
  alert() {
    return screen.findByRole('alert', { name: /^(Couldn’t|Your browser)/ })
  }

  queryAlert() {
    return screen.queryByRole('alert', { name: /^(Couldn’t|Your browser)/ })
  }

  reload() {
    return screen.findByRole('button', { name: 'Reload' })
  }

  // The screen with a stand-in caller around it (ScoringScreen.match.tsx),
  // for a journey across games.
  renderMatch(match: { bestOf: BestOf; games: Games }) {
    return renderScreen(<Match {...match} />, { path: '/scoring' })
  }

  // "Enter game N score." or "Edit game N score." Found by that name, so
  // after a link to this screen it waits for it, not the page left behind.
  heading() {
    return screen.findByRole('heading', {
      level: 1,
      name: /^(Enter|Edit) game \d+ score\.$/,
    })
  }

  yours() {
    return screen.findByRole('textbox', { name: 'Your score' })
  }

  // The opponent's field.
  theirs() {
    return screen.findByRole('textbox', { name: 'Opponent’s score' })
  }

  // The games won so far, under VS ("Games won: 1 – 0"), or null.
  tally() {
    return screen.queryByText('Games won:')?.closest('p') ?? null
  }

  // The one error line, or null: the alert with no name (the device's
  // refusal is named by its title).
  error() {
    return screen.queryByRole('alert', { name: '' })
  }

  // The submit, by its label ("Save game & next", "Finish match"...).
  submit() {
    return screen.findByRole('button', { name: /^(Save|Finish)/ })
  }

  // What saving does, the line beside the submit.
  subtitle(text: string) {
    return screen.findByText(text, { selector: 'p' })
  }

  clear() {
    return screen.queryByRole('button', { name: 'Clear' })
  }

  scoreline() {
    return screen.findByRole('navigation', { name: 'Scoreline' })
  }

  // Game n's cell in the scoreline (its list item).
  async cell(n: number) {
    const cells = within(await this.scoreline()).getAllByRole('listitem')
    return cells[n - 1]
  }

  // Game n's cell as a link, or null when it isn't one.
  async cellLink(n: number) {
    return within(await this.cell(n)).queryByRole('link')
  }

  // The stand-in caller's way out of scoring (renderMatch only): its
  // "Dashboard" link, to `/`.
  dashboardLink() {
    return screen.findByRole('link', { name: 'Dashboard' })
  }

  // The scoreline's polite live region, which reads out "Game N updated."
  // on each change made elsewhere; empty before the first.
  async updated() {
    return within(await this.scoreline()).findByRole('status')
  }

  // The notice that this empty game's match was finished elsewhere: its
  // title.
  finished() {
    return screen.findByText('This match was finished since you opened this page.')
  }

  queryFinished() {
    return screen.queryByText('This match was finished since you opened this page.')
  }

  // The finished notice's link to the match's page.
  goToMatch() {
    return screen.findByRole('link', { name: 'Go to the match' })
  }

  // "Leave without saving?", and its answers.
  leaveDialog() {
    return screen.findByRole('dialog', { name: 'Leave without saving?' })
  }

  queryLeaveDialog() {
    return screen.queryByRole('dialog', { name: 'Leave without saving?' })
  }

  keepEditing() {
    return screen.findByRole('button', { name: 'Keep editing' })
  }

  discardAndLeave() {
    return screen.findByRole('button', { name: 'Discard & leave' })
  }
}

