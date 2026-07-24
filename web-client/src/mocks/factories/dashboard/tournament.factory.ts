import type { components } from '@/api/schema'

type DashboardTournament = components['schemas']['DashboardTournament']
type DashboardTournamentEvent =
  components['schemas']['DashboardTournamentEvent']
type DashboardTournamentMatch =
  components['schemas']['DashboardTournamentMatch']
type DashboardTournamentFixtureRow =
  components['schemas']['DashboardTournamentFixtureRow']
type DashboardTournamentGame = components['schemas']['DashboardTournamentGame']

/** One completed game, always the viewer's points first. */
export function buildDashboardTournamentGame(
  overrides: Partial<DashboardTournamentGame> = {},
): DashboardTournamentGame {
  return { number: 1, your_points: 11, opponent_points: 7, ...overrides }
}

/**
 * The viewer's live match: a called best-of-five on Table 4, three games in and
 * 2–1 up, with game 4 next. The design's headline case.
 */
export function buildDashboardTournamentMatch(
  overrides: Partial<DashboardTournamentMatch> = {},
): DashboardTournamentMatch {
  return {
    state: 'live',
    match_id: 'm-1',
    opponent_username: 'slim-manatee',
    your_games: 2,
    opponent_games: 1,
    best_of: 5,
    games: [
      buildDashboardTournamentGame({ number: 1, your_points: 11, opponent_points: 7 }),
      buildDashboardTournamentGame({ number: 2, your_points: 8, opponent_points: 11 }),
      buildDashboardTournamentGame({ number: 3, your_points: 11, opponent_points: 9 }),
    ],
    round_label: 'Group match 2',
    table_label: 'Table 4',
    start_label: '4:30 PM CDT',
    next_game_number: 4,
    // `null` while a match is unfinished — never `false`, which would claim a
    // loss on a match still being played.
    you_won: null,
    ...overrides,
  }
}

/** One line of the viewer's own schedule — a won first group match. */
export function buildDashboardTournamentFixtureRow(
  overrides: Partial<DashboardTournamentFixtureRow> = {},
): DashboardTournamentFixtureRow {
  return {
    label: 'M1',
    opponent_username: 'celestial-caracara',
    state: 'completed',
    detail: 'Won 3–1',
    you_won: true,
    match_id: 'm-0',
    ...overrides,
  }
}

/**
 * One event tab: a four-strong round-robin group the viewer leads, one match
 * won, one live, one to come — deliberately mixed, so a projection that ignored
 * a row's own state could not pass.
 */
export function buildDashboardTournamentEvent(
  overrides: Partial<DashboardTournamentEvent> = {},
): DashboardTournamentEvent {
  return {
    id: 'e-1',
    name: 'U1500 · Group B',
    draw_type: 'round-robin',
    is_live: true,
    wins: 1,
    losses: 0,
    position: 1,
    field_size: 4,
    stage_label: 'Group play',
    pool_label: 'Pool B',
    match: buildDashboardTournamentMatch(),
    fixtures: [
      buildDashboardTournamentFixtureRow(),
      buildDashboardTournamentFixtureRow({
        label: 'M2',
        opponent_username: 'slim-manatee',
        state: 'live',
        detail: 'In progress',
        you_won: null,
        match_id: 'm-1',
      }),
      buildDashboardTournamentFixtureRow({
        label: 'M3',
        opponent_username: 'bold-bison',
        state: 'upcoming',
        detail: '5:20 PM CDT · Table 6',
        you_won: null,
        match_id: 'm-2',
      }),
    ],
    ...overrides,
  }
}

/** A live tournament with one event the viewer is playing in. */
export function buildDashboardTournament(
  overrides: Partial<DashboardTournament> = {},
): DashboardTournament {
  return {
    id: 't-1',
    name: 'Riverside Summer Slam',
    subtitle: 'Riverside TTC · Jul 24–25',
    live_count: 1,
    events: [buildDashboardTournamentEvent()],
    ...overrides,
  }
}
