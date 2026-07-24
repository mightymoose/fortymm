import { buildTournamentPathRowView } from './tournament-path-list/tournament-path-row.factory'
import { tournamentPathListPage } from './tournament-path-list.page'

describe('TournamentPathList', () => {
  it('renders one row per fixture, in the order given', () => {
    tournamentPathListPage.render()

    // Wiring only: each row's own content is pinned by the path-row tests.
    const rows = tournamentPathListPage.getRows()
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('M1')
    expect(rows[2]).toHaveTextContent('M3')
  })

  it('takes its heading from the view', () => {
    tournamentPathListPage.render({ heading: 'Your path' })

    expect(tournamentPathListPage.getHeading('Your path')).toBeInTheDocument()
  })

  it('names the pool and its size beneath the heading', () => {
    tournamentPathListPage.render({ subheading: 'Pool B · 6 players' })

    expect(tournamentPathListPage.queryList()).toHaveTextContent(
      'Pool B · 6 players',
    )
  })

  it('omits the subheading line for an un-pooled draw', () => {
    tournamentPathListPage.render({ subheading: null })

    expect(tournamentPathListPage.queryList()).not.toHaveTextContent('players')
  })

  it('renders nothing when the draw has not been cut', () => {
    // A heading over an empty list would read as "you have no matches" rather
    // than "the draw is not made yet".
    tournamentPathListPage.render({ rows: [] })

    expect(tournamentPathListPage.queryList()).toBeNull()
  })

  it('keys rows independently of the opponent, so a repeat opponent still renders twice', () => {
    tournamentPathListPage.render({
      rows: [
        buildTournamentPathRowView({ key: 'a', label: 'M1' }),
        buildTournamentPathRowView({ key: 'b', label: 'M2' }),
      ],
    })

    expect(tournamentPathListPage.getRows()).toHaveLength(2)
  })
})
