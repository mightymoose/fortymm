import { buildTournamentStatsView } from './tournament-stats-strip.factory'
import { tournamentStatsStripPage } from './tournament-stats-strip.page'

describe('TournamentStatsStrip', () => {
  it('prints the record as wins–losses', () => {
    tournamentStatsStripPage.render({
      stats: buildTournamentStatsView({ wins: 2, losses: 1 }),
    })

    expect(
      tournamentStatsStripPage.getTileValue('Match record'),
    ).toHaveTextContent('2–1')
  })

  it('names the standing and the field it is out of', () => {
    tournamentStatsStripPage.render({
      stats: buildTournamentStatsView({
        positionValue: '3rd',
        positionSuffix: 'of 6',
      }),
    })

    expect(
      tournamentStatsStripPage.getTileValue('Group position'),
    ).toHaveTextContent('3rd of 6')
  })

  it('renders an em-dash when the event has no standings yet', () => {
    // An uncut draw has nothing to stand in. The tile keeps its place so the
    // strip does not reflow the moment the draw is cut.
    tournamentStatsStripPage.render({
      stats: buildTournamentStatsView({
        positionValue: null,
        positionSuffix: null,
      }),
    })

    const value = tournamentStatsStripPage.getTileValue('Group position')
    expect(value).toHaveTextContent('—')
    expect(value).not.toHaveTextContent('of')
  })

  it('takes the position tile label from the view, not the markup', () => {
    // Round-robin says "Group position"; a bracket draw would say "Position".
    tournamentStatsStripPage.render({
      stats: buildTournamentStatsView({ positionLabel: 'Position' }),
    })

    expect(tournamentStatsStripPage.getTileValue('Position')).toHaveTextContent(
      '1st',
    )
  })

  it('shows the stage the event has reached', () => {
    tournamentStatsStripPage.render({
      stats: buildTournamentStatsView({ stageValue: 'Group complete' }),
    })

    expect(tournamentStatsStripPage.getTileValue('Stage')).toHaveTextContent(
      'Group complete',
    )
  })
})
