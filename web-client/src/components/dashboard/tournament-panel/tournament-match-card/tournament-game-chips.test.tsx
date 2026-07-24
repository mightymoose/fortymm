import { buildTournamentGameChipView } from './tournament-game-chips.factory'
import { tournamentGameChipsPage } from './tournament-game-chips.page'

describe('TournamentGameChips', () => {
  it('renders one chip per played game, in play order', () => {
    tournamentGameChipsPage.render()

    const chips = tournamentGameChipsPage.getChips()
    expect(chips).toHaveLength(3)
    expect(chips[0]).toHaveTextContent('Game 1')
    expect(chips[0]).toHaveTextContent('11–7')
    expect(chips[2]).toHaveTextContent('11–9')
  })

  it('gives each chip a spoken sentence naming both players', () => {
    // Two bare numbers are ambiguous read aloud; the visible score is hidden
    // from assistive tech and the sentence replaces it.
    tournamentGameChipsPage.render({
      games: [
        buildTournamentGameChipView({
          score: '11–7',
          description: 'Game 1: mightymoose 11, slim-manatee 7',
        }),
      ],
    })

    const [chip] = tournamentGameChipsPage.getChips()
    expect(chip).toHaveTextContent('Game 1: mightymoose 11, slim-manatee 7')
    expect(chip.querySelector('[aria-hidden="true"]')).toHaveTextContent('11–7')
  })

  it('states whose points come first', () => {
    tournamentGameChipsPage.render({
      legend: 'bold-bison shown first · vs lunar-lynx',
    })

    expect(tournamentGameChipsPage.queryChips()).toHaveTextContent(
      'bold-bison shown first · vs lunar-lynx',
    )
  })

  it('renders nothing before the first game is played', () => {
    tournamentGameChipsPage.render({ games: [] })

    expect(tournamentGameChipsPage.queryChips()).toBeNull()
  })
})
