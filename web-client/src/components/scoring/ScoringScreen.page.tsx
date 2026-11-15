import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import type { BestOf, Score } from '../../scoring/scoring.ts'
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
  renderMatch(match: { opponentName: string; bestOf: BestOf; games: Score[] }) {
    return renderScreen(<Match {...match} />, { path: '/scoring' })
  }

  // "Enter game N score." or "Edit game N score."
  heading() {
    return screen.findByRole('heading', { level: 1 })
  }

  yours() {
    return screen.findByRole('textbox', { name: 'Your score' })
  }

  // The opponent's field, by their name ("Ana’s score").
  theirs(opponentName: string) {
    return screen.findByRole('textbox', { name: `${opponentName}’s score` })
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

  // The ✕ on a scoreline cell, "Clear game N", or null.
  clearCell(n: number) {
    return screen.queryByRole('button', { name: `Clear game ${n}` })
  }

  // "Clear game N?", and its answers.
  clearDialog(n: number) {
    return screen.findByRole('dialog', { name: `Clear game ${n}?` })
  }

  keepScore() {
    return screen.findByRole('button', { name: 'Keep score' })
  }

  clearGame() {
    return screen.findByRole('button', { name: 'Clear game' })
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

