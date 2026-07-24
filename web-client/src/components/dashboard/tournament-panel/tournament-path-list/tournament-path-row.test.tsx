import { buildTournamentPathRowView } from './tournament-path-row.factory'
import { tournamentPathRowPage } from './tournament-path-row.page'

describe('TournamentPathRow', () => {
  it('names the opponent and the result', () => {
    tournamentPathRowPage.render({
      row: buildTournamentPathRowView({
        label: 'M2',
        opponentName: 'slim-manatee',
        detail: 'Won 3–1',
      }),
    })

    const row = tournamentPathRowPage.getRow('M2')
    expect(row).toHaveTextContent('M2')
    expect(row).toHaveTextContent('slim-manatee')
    expect(row).toHaveTextContent('Won 3–1')
  })

  it('tones a loss away from the win colour', () => {
    tournamentPathRowPage.render({
      row: buildTournamentPathRowView({ youWon: false, detail: 'Lost 1–3' }),
    })

    expect(tournamentPathRowPage.getRow('M1')).toHaveTextContent('Lost 1–3')
    expect(
      tournamentPathRowPage.getRow('M1').querySelector('.text-\\[color\\:var\\(--loss\\)\\]'),
    ).not.toBeNull()
  })

  it('outlines a live row so it reads as the one being played', () => {
    tournamentPathRowPage.render({
      row: buildTournamentPathRowView({
        state: 'live',
        detail: 'In progress',
        youWon: null,
      }),
    })

    const row = tournamentPathRowPage.getRow('M1')
    expect(row).toHaveTextContent('In progress')
    expect(row.className).toContain('border-[color:var(--serve-500)]/40')
  })

  it('shows an upcoming match as its time and table', () => {
    tournamentPathRowPage.render({
      row: buildTournamentPathRowView({
        label: 'M3',
        state: 'upcoming',
        detail: '5:20 PM CDT · Table 6',
        youWon: null,
      }),
    })

    expect(tournamentPathRowPage.getRow('M3')).toHaveTextContent(
      '5:20 PM CDT · Table 6',
    )
  })

  it('shows TBD rather than a blank where the opponent is undecided', () => {
    tournamentPathRowPage.render({
      row: buildTournamentPathRowView({
        opponentName: 'TBD',
        state: 'upcoming',
        detail: 'Not scheduled',
        youWon: null,
      }),
    })

    expect(tournamentPathRowPage.getRow('M1')).toHaveTextContent('TBD')
  })
})
