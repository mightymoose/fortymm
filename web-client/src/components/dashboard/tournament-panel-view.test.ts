import {
  buildDashboardTournament,
  buildDashboardTournamentEvent,
  buildDashboardTournamentMatch,
} from '@/mocks/factories/dashboard/tournament.factory'
import {
  projectTournamentPanelView,
  projectTournamentPanelViews,
} from './tournament-panel-view'

const project = (
  tournament = buildDashboardTournament(),
  youName = 'mightymoose',
) => projectTournamentPanelView(tournament, youName)

describe('projectTournamentPanelView', () => {
  it('carries the tournament header through', () => {
    const view = project(
      buildDashboardTournament({
        id: 't-9',
        name: 'Riverside Summer Slam',
        subtitle: 'Riverside TTC · Jul 24–25',
      }),
    )

    expect(view.tournamentId).toBe('t-9')
    expect(view.name).toBe('Riverside Summer Slam')
    expect(view.subtitle).toBe('Riverside TTC · Jul 24–25')
  })

  it('counts the live matches into a pill, and drops it at zero', () => {
    expect(project(buildDashboardTournament({ live_count: 1 })).liveLabel).toBe(
      '1 live now',
    )
    expect(
      project(buildDashboardTournament({ live_count: 0 })).liveLabel,
    ).toBeNull()
  })

  it('sends a round-robin viewer to the standings, not a bracket', () => {
    expect(project().destinationLabel).toBe('View group & standings')
  })

  describe('the stats strip', () => {
    it('renders the standing as an ordinal out of the field', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({ position: 3, field_size: 6 }),
          ],
        }),
      )

      expect(view.tabs[0].stats.positionValue).toBe('3rd')
      expect(view.tabs[0].stats.positionSuffix).toBe('of 6')
    })

    it.each([
      [1, '1st'],
      [2, '2nd'],
      [3, '3rd'],
      [4, '4th'],
      [11, '11th'],
      [12, '12th'],
      [13, '13th'],
      [21, '21st'],
    ])('renders position %i as %s', (position, expected) => {
      const view = project(
        buildDashboardTournament({
          events: [buildDashboardTournamentEvent({ position })],
        }),
      )

      expect(view.tabs[0].stats.positionValue).toBe(expected)
    })

    it('leaves the position null when the event has no standings yet', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({ position: null, field_size: 0 }),
          ],
        }),
      )

      expect(view.tabs[0].stats.positionValue).toBeNull()
      expect(view.tabs[0].stats.positionSuffix).toBeNull()
    })
  })

  describe('the match card', () => {
    it('says which game a live match is on, from the next game up', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                table_label: 'Table 4',
                next_game_number: 4,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.statusText).toBe('Live · Table 4 · Game 4')
    })

    it('falls back to the game after the last played one when there is no next', () => {
      // A decided-but-unposted board reports no next game; the card still has
      // to name the game the players are standing at.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                next_game_number: null,
                games: [
                  { number: 1, your_points: 11, opponent_points: 7 },
                  { number: 2, your_points: 11, opponent_points: 9 },
                ],
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.statusText).toContain('Game 3')
    })

    it('names the round and table of a finished match', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'completed',
                round_label: 'Group match 2',
                table_label: 'Table 4',
                you_won: true,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.statusText).toBe(
        'Match complete · Group match 2 · Table 4',
      )
    })

    it('crowns the winner and only the winner', () => {
      const won = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'completed',
                you_won: true,
              }),
            }),
          ],
        }),
      ).tabs[0].match
      const lost = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'completed',
                you_won: false,
              }),
            }),
          ],
        }),
      ).tabs[0].match

      expect([won?.youWon, won?.opponentWon]).toEqual([true, false])
      expect([lost?.youWon, lost?.opponentWon]).toEqual([false, true])
    })

    it('crowns nobody while the match is unfinished', () => {
      // `you_won` is null mid-match; treating that as `false` would put the
      // winner chip on the opponent of every live match.
      const view = project()

      expect(view.tabs[0].match?.youWon).toBe(false)
      expect(view.tabs[0].match?.opponentWon).toBe(false)
    })

    it('offers the next game as the primary action on a live match', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                match_id: 'm-7',
                next_game_number: 4,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.action?.label).toBe('Enter Game 4 result')
      expect(view.tabs[0].match?.action?.route.params).toEqual({
        matchId: 'm-7',
        gameNumber: '4',
      })
    })

    it.each([
      ['a match that is not live', { state: 'scheduled' as const }],
      ['a decided board with no next game', { next_game_number: null }],
      ['a fixture with no match behind it', { match_id: null }],
    ])('offers no action for %s', (_case, overrides) => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch(overrides),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.action).toBeNull()
    })

    it('drops the match-details link for a fixture with no match', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'scheduled',
                match_id: null,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.detailsRoute).toBeNull()
    })

    it('shows the time and table of a match not yet started', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'scheduled',
                start_label: '5:20 PM CDT',
                table_label: 'Table 6',
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.scheduleText).toBe('5:20 PM CDT · Table 6')
    })

    it('says so plainly when an upcoming match has no placement', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'scheduled',
                start_label: null,
                table_label: null,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.scheduleText).toBe('Not scheduled yet')
    })

    it('labels the game chips with the viewer’s own points first', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                games: [{ number: 2, your_points: 11, opponent_points: 9 }],
                opponent_username: 'slim-manatee',
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.games).toEqual([
        {
          label: 'Game 2',
          score: '11–9',
          description: 'Game 2: mightymoose 11, slim-manatee 9',
        },
      ])
      expect(view.tabs[0].match?.gamesLegend).toBe(
        'mightymoose shown first · vs slim-manatee',
      )
    })

    it('drops the legend when no game has been played', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({ games: [] }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.gamesLegend).toBeNull()
    })

    it('calls an undecided opposing side TBD', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                opponent_username: null,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.opponentName).toBe('TBD')
    })
  })

  describe('the path list', () => {
    it('keys rows by their ordinal so a repeated opponent still renders twice', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              id: 'e-4',
              fixtures: [
                {
                  label: 'M1',
                  opponent_username: 'bold-bison',
                  state: 'completed',
                  detail: 'Won 3–1',
                  you_won: true,
                  match_id: null,
                },
                {
                  label: 'M2',
                  opponent_username: 'bold-bison',
                  state: 'upcoming',
                  detail: 'Not scheduled',
                  you_won: null,
                  match_id: null,
                },
              ],
            }),
          ],
        }),
      )

      expect(view.tabs[0].path.map((row) => row.key)).toEqual(['e-4-0', 'e-4-1'])
    })

    it('names the pool and its size beneath the heading', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              pool_label: 'Pool B',
              field_size: 4,
            }),
          ],
        }),
      )

      expect(view.tabs[0].pathSubheading).toBe('Pool B · 4 players')
      expect(view.tabs[0].pathHeading).toBe('Your matches')
    })

    it('has no subheading for an un-pooled draw', () => {
      const view = project(
        buildDashboardTournament({
          events: [buildDashboardTournamentEvent({ pool_label: null })],
        }),
      )

      expect(view.tabs[0].pathSubheading).toBeNull()
    })
  })
})

describe('projectTournamentPanelViews', () => {
  it('projects one panel per tournament', () => {
    const views = projectTournamentPanelViews(
      [
        buildDashboardTournament({ id: 't-1' }),
        buildDashboardTournament({ id: 't-2' }),
      ],
      'mightymoose',
    )

    expect(views.map((view) => view.tournamentId)).toEqual(['t-1', 't-2'])
  })

  it('renders nothing until the viewer’s own handle is known', () => {
    // Every score on the payload is stated from the caller's side; without a
    // name for them the card would label their own row "undefined".
    expect(
      projectTournamentPanelViews([buildDashboardTournament()], undefined),
    ).toEqual([])
  })

  it('drops a tournament with no events rather than rendering a husk', () => {
    expect(
      projectTournamentPanelViews(
        [buildDashboardTournament({ events: [] })],
        'mightymoose',
      ),
    ).toEqual([])
  })

  it('is empty when the viewer is in no tournament', () => {
    expect(projectTournamentPanelViews([], 'mightymoose')).toEqual([])
  })
})
