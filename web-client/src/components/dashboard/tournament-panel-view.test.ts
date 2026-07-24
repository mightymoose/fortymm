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

    it('names no game at all when the board is decided but unposted', () => {
      // `next_game_number: null` means there is no next game — the match is
      // already decided, only the result is unposted. Inventing "Game 3" here
      // would announce a game that will never be played, and contradict the
      // action button beside it, which correctly offers nothing to enter.
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

      expect(view.tabs[0].match?.statusText).not.toContain('Game')
      expect(view.tabs[0].match?.statusText).toBe('Live · Table 4')
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

    it('offers the result as the action once the board is decided', () => {
      // The decided-but-unposted state. Answering `null` here dead-ended the
      // card at the one moment the player most needs a way forward — while the
      // attention panel beneath it offered a button for the very same match.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                match_id: 'm-7',
                next_game_number: null,
                owed_action: 'score',
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.action?.label).toBe('Post the result')
      expect(view.tabs[0].match?.action?.route.params).toEqual({
        matchId: 'm-7',
      })
    })

    it('asks the reviewer to REVIEW, not to post what is already posted', () => {
      // `next_game_number: null` is two different states. This is the one where
      // the OPPONENT has posted a result: telling this player to "Post the
      // result" names a job that is done, and done by someone else.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                match_id: 'm-7',
                next_game_number: null,
                owed_action: 'review',
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.action?.label).toBe('Review result')
      expect(view.tabs[0].match?.action?.route.params).toEqual({ matchId: 'm-7' })
    })

    it('offers nothing while OUR posted result waits on the opponent', () => {
      // We posted; the move is theirs. A button here would invite us to redo it.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'live',
                next_game_number: null,
                owed_action: 'waiting_opponent',
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.action).toBeNull()
    })

    it.each([
      ['a match that is not live', { state: 'scheduled' as const }],
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

    it('reports a voided match as voided, with no winner', () => {
      // A voided match contributes nothing (ADR-0013). It must not read as a
      // completed one, which would derive a loss from the empty board.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({
                state: 'voided',
                round_label: 'Group match 2',
                games: [],
                your_games: 0,
                opponent_games: 0,
                you_won: null,
              }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.statusText).toBe('Match voided · Group match 2')
      expect(view.tabs[0].match?.youWon).toBe(false)
      expect(view.tabs[0].match?.opponentWon).toBe(false)
      expect(view.tabs[0].match?.action).toBeNull()
    })

    it('frames a best-of-1 as a single game, not "Best of 1"', () => {
      // The copy #908 settled for every surface that states a match length —
      // the "Best of N" race framing only means something for a multi-game set.
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({ best_of: 1 }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.bestOfText).toBe('Single game')
    })

    it('keeps the "Best of N" framing for a multi-game set', () => {
      const view = project(
        buildDashboardTournament({
          events: [
            buildDashboardTournamentEvent({
              match: buildDashboardTournamentMatch({ best_of: 5 }),
            }),
          ],
        }),
      )

      expect(view.tabs[0].match?.bestOfText).toBe('Best of 5')
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
