import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import type { BestOf, Games } from '../../scoring/scoring.ts'
import { Match } from './ScoringScreen.match.tsx'
import { ScoringScreen, type ScoringScreenProps } from './ScoringScreen.tsx'

// The scoring screen (ScoringScreen.tsx): how to render it alone, and what a
// person sees on it. The finders work wherever the screen is mounted.
export class ScoringScreenPage {
  render(props: ScoringScreenProps) {
    return renderScreen(<ScoringScreen {...props} />, { path: '/scoring' })
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

  // The one error line, or null.
  error() {
    return screen.queryByRole('alert')
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

