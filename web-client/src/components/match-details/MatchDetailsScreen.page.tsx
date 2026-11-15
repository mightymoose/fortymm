import { screen, within } from '@testing-library/react'
import { renderScreen } from '../../test/render-screen.tsx'
import { MatchDetailsScreen } from './MatchDetailsScreen.tsx'

// The match details screen (MatchDetailsScreen.tsx): how to render it alone,
// and what a person sees on it. The finders work wherever the screen is
// mounted, through its route (src/routes/matches/$matchId/index.test.tsx) too.
export class MatchDetailsScreenPage {
  render(props: Parameters<typeof MatchDetailsScreen>[0]) {
    return renderScreen(<MatchDetailsScreen {...props} />, {
      path: '/matches/m-1',
    })
  }

  // The title, "You vs <opponent>".
  heading() {
    return screen.findByRole('heading', { level: 1, name: /^You vs / })
  }

  // The link back to the matches.
  back() {
    return screen.findByRole('link', { name: 'Matches' })
  }

  score() {
    return screen.findByRole('link', { name: 'Score' })
  }

  queryScore() {
    return screen.queryByRole('link', { name: 'Score' })
  }

  // The scoreboard, a region named by the match's state ("In progress",
  // "Final · You won").
  scoreboard() {
    return screen.findByRole('region', { name: /^In progress$|^Final/ })
  }

  // The scoreboard's tally in games, "2 – 1": yours first.
  async tally() {
    return within(await this.scoreboard()).getByText(/^\d+ – \d+$/)
  }

  // The scoreboard's line with the format ("Best of 5 · Unrated").
  async format() {
    return within(await this.scoreboard()).getByText(/^Best of|^Single game/)
  }

  // A player's name on the scoreboard: "You", or the opponent's.
  async player(name: string) {
    return within(await this.scoreboard()).getByText(name)
  }

  // The games' section, named "Games".
  games() {
    return screen.findByRole('region', { name: 'Games' })
  }

  // The games' table, or null when no game is saved.
  async queryGamesTable() {
    return within(await this.games()).queryByRole('table', { name: 'Games' })
  }

  // The row of game `n` (from 1), its header "Game n".
  async game(n: number) {
    const table = within(await this.games()).getByRole('table', {
      name: 'Games',
    })
    return within(table).getByRole('row', { name: new RegExp(`^Game ${n} `) })
  }
}
