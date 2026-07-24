import { scoringNewRoute } from '@/api/matches'
import { buildTournamentMatchCardView } from './tournament-match-card.factory'
import { tournamentMatchCardPage } from './tournament-match-card.page'

describe('TournamentMatchCard', () => {
  it('prints the games-won score against each player', async () => {
    tournamentMatchCardPage.render()

    await tournamentMatchCardPage.findCard()
    expect(tournamentMatchCardPage.getScoreRow('mightymoose')).toHaveTextContent(
      '2',
    )
    expect(
      tournamentMatchCardPage.getScoreRow('slim-manatee'),
    ).toHaveTextContent('1')
  })

  it('says where and what game a live match is on', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({
        statusText: 'Live · Table 6 · Game 2',
      }),
    })

    const card = await tournamentMatchCardPage.findCard()
    expect(card).toHaveTextContent('Live · Table 6 · Game 2')
    expect(card).toHaveTextContent('Best of 5')
  })

  it('deep-links the primary action to the game about to be played', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({
        action: {
          label: 'Enter Game 4 result',
          route: scoringNewRoute('m-9', 4),
        },
      }),
    })

    await tournamentMatchCardPage.findCard()
    expect(
      tournamentMatchCardPage.queryActionLink('Enter Game 4 result'),
    ).toHaveAttribute('href', '/matches/m-9/games/4/scores/new')
  })

  it('offers no primary action when there is nothing to enter', async () => {
    // An uncalled match is not scorable; a button that 409s is worse than none.
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({
        state: 'scheduled',
        statusText: 'Group match 3',
        action: null,
        games: [],
        gamesLegend: null,
        scheduleText: '5:20 PM CDT · Table 6',
      }),
    })

    await tournamentMatchCardPage.findCard()
    expect(tournamentMatchCardPage.queryActionLink(/enter game/i)).toBeNull()
    expect(tournamentMatchCardPage.queryDetailsLink()).toHaveAttribute(
      'href',
      '/matches/m-1',
    )
  })

  it('shows when and where a match not yet started will be played', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({
        state: 'scheduled',
        statusText: 'Group match 3',
        action: null,
        games: [],
        gamesLegend: null,
        scheduleText: '5:20 PM CDT · Table 6',
      }),
    })

    const card = await tournamentMatchCardPage.findCard()
    expect(card).toHaveTextContent('5:20 PM CDT · Table 6')
  })

  it('crowns only the winner of a finished match', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({
        state: 'completed',
        statusText: 'Match complete · Group match 2 · Table 4',
        yourGames: 3,
        opponentGames: 1,
        youWon: true,
        opponentWon: false,
        action: null,
      }),
    })

    await tournamentMatchCardPage.findCard()
    expect(tournamentMatchCardPage.getScoreRow('mightymoose')).toHaveTextContent(
      'Winner',
    )
    expect(
      tournamentMatchCardPage.getScoreRow('slim-manatee'),
    ).not.toHaveTextContent('Winner')
  })

  it('crowns nobody while the match is still being played', async () => {
    // `youWon`/`opponentWon` are both false mid-match — a running 2–1 has no
    // winner, and a card that crowned the leader would be claiming a result.
    tournamentMatchCardPage.render()

    const card = await tournamentMatchCardPage.findCard()
    expect(card).not.toHaveTextContent('Winner')
  })

  it('glows only while the match is live', async () => {
    tournamentMatchCardPage.render()
    expect(await tournamentMatchCardPage.findCard()).toHaveClass(
      'border-[color:var(--serve-500)]/35',
    )
  })

  it('drops the glow once the match is over', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({ state: 'completed', action: null }),
    })

    expect(await tournamentMatchCardPage.findCard()).toHaveClass(
      'border-[color:var(--border-subtle)]',
    )
  })

  it('wires the played games through to the chips', async () => {
    // Wiring only: chip content is pinned by the game-chips tests.
    tournamentMatchCardPage.render()

    await tournamentMatchCardPage.findCard()
    expect(tournamentMatchCardPage.chips.getChips()).toHaveLength(3)
  })

  it('renders no chips block before the first game is played', async () => {
    tournamentMatchCardPage.render({
      match: buildTournamentMatchCardView({ games: [], gamesLegend: null }),
    })

    await tournamentMatchCardPage.findCard()
    expect(tournamentMatchCardPage.chips.queryChips()).toBeNull()
  })
})
