import type { components } from '@/api/schema'

import { buildMatchDetailsData } from './scoreboard.factory'

type MatchDetails = components['schemas']['app__schemas__match__MatchDetails']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsPlayer = components['schemas']['MatchDetailsPlayer']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchDetailsScore = components['schemas']['MatchDetailsScore']
type MatchDetailsCurrentGame = components['schemas']['MatchDetailsCurrentGame']
type MatchSignatureView = components['schemas']['MatchSignatureView']
type MatchDetailsPlayerForm = components['schemas']['MatchDetailsPlayerForm']
type MatchDetailsFormResult = components['schemas']['MatchDetailsFormResult']
type MatchDetailsH2H = components['schemas']['MatchDetailsH2H']
type MatchDetailsH2HMeeting = components['schemas']['MatchDetailsH2HMeeting']
type MatchLeague = components['schemas']['MatchLeague']

const DEFAULT_LEAGUE: MatchLeague = {
  id: 'lg-fortymm',
  name: 'FortyMM',
}

/** A single side's player. */
export function buildMatchDetailsPlayer(
  overrides: Partial<MatchDetailsPlayer> = {},
): MatchDetailsPlayer {
  return {
    user_id: 'u-me',
    username: 'rita.kovac',
    is_current_user: true,
    ...overrides,
  }
}

/** One side of the match (sides[0] = side 1 by convention). */
export function buildMatchDetailsSide(
  overrides: Partial<MatchDetailsSide> = {},
): MatchDetailsSide {
  return {
    side_number: 1,
    players: [buildMatchDetailsPlayer()],
    games_won: 0,
    won: null,
    is_current_user_side: true,
    rating_change: null,
    ...overrides,
  }
}

/** A single game's score line. */
export function buildMatchDetailsScore(
  overrides: Partial<MatchDetailsScore> = {},
): MatchDetailsScore {
  const side1 = overrides.side_1_points ?? 11
  const side2 = overrides.side_2_points ?? 7
  return {
    id: 'score-1',
    side_1_points: side1,
    side_2_points: side2,
    winner_side_number: side1 > side2 ? 1 : 2,
    version: 1,
    ...overrides,
  }
}

/** A game within the match, optionally scored. */
export function buildMatchDetailsGame(
  overrides: Partial<MatchDetailsGame> = {},
): MatchDetailsGame {
  return {
    id: 'game-1',
    game_number: 1,
    score: null,
    ...overrides,
  }
}

/** One past result in a player's recent-form list — a 3–1 win over silva.r. */
export function buildMatchDetailsFormResult(
  overrides: Partial<MatchDetailsFormResult> = {},
): MatchDetailsFormResult {
  return {
    match_id: 'm-prev-1',
    is_win: true,
    player_games_won: 3,
    opponent_games_won: 1,
    opponent_username: 'silva.r',
    completed_at: '2026-05-09T18:00:00Z',
    ...overrides,
  }
}

/**
 * A player's pre-match form entry as it appears in `recent_form` — rita.kovac
 * (`u-me`) rated 1612 with a rising history and a 9–3 career going in.
 */
export function buildMatchDetailsPlayerForm(
  overrides: Partial<MatchDetailsPlayerForm> = {},
): MatchDetailsPlayerForm {
  return {
    user_id: 'u-me',
    recent_results: [buildMatchDetailsFormResult()],
    rating_before: 1612,
    rating_history: [1580, 1601, 1612],
    career_matches_before: 12,
    career_wins_before: 9,
    ...overrides,
  }
}

/** One past meeting in the head-to-head record — a 3–2 win for side 1 on
 * 2026-05-08, framed against this match's side numbers. */
export function buildMatchDetailsH2HMeeting(
  overrides: Partial<MatchDetailsH2HMeeting> = {},
): MatchDetailsH2HMeeting {
  return {
    match_id: 'm-h2h-1',
    completed_at: '2026-05-08T18:00:00Z',
    side_1_games_won: 3,
    side_2_games_won: 2,
    winner_side_number: 1,
    rated: true,
    ...overrides,
  }
}

/** The head-to-head record between this match's two sides — side 1 leads 2–1
 * across three prior meetings, with one meeting in `recent_meetings`. */
export function buildMatchDetailsH2H(
  overrides: Partial<MatchDetailsH2H> = {},
): MatchDetailsH2H {
  return {
    total_meetings: 3,
    side_1_wins: 2,
    side_2_wins: 1,
    recent_meetings: [buildMatchDetailsH2HMeeting()],
    ...overrides,
  }
}

/**
 * A full `MatchDetails` payload as returned by `GET /v1/matches/{match_id}`.
 * Defaults to a pending best-of-5 singles match with the mock current user on
 * side 1. Pass partial overrides to shape any field.
 */
export function buildMatchDetails(
  overrides: Partial<MatchDetails> = {},
): MatchDetails {
  const sides: MatchDetailsSide[] = overrides.sides ?? [
    buildMatchDetailsSide(),
    buildMatchDetailsSide({
      side_number: 2,
      players: [
        buildMatchDetailsPlayer({
          user_id: 'u-opponent',
          username: 'leo.mertens',
          is_current_user: false,
        }),
      ],
      is_current_user_side: false,
    }),
  ]

  const currentGame: MatchDetailsCurrentGame | null =
    overrides.current_game !== undefined
      ? overrides.current_game
      : { game_number: 1 }

  return {
    id: 'match-1',
    status: 'pending',
    status_label: 'Scheduled',
    league: DEFAULT_LEAGUE,
    best_of: 5,
    games_to_win: 3,
    team_size: 1,
    affects_rating: true,
    created_at: '2026-06-08T12:00:00Z',
    sides,
    games: [],
    current_game: currentGame,
    can_score: false,
    can_finalize: false,
    can_confirm: false,
    signatures: [],
    disputed_by_user_id: null,
    recent_form: [],
    head_to_head: null,
    data: buildMatchDetailsData(),
    ...overrides,
  }
}

export type {
  MatchDetails,
  MatchDetailsSide,
  MatchDetailsPlayer,
  MatchDetailsGame,
  MatchDetailsScore,
  MatchDetailsCurrentGame,
  MatchSignatureView,
  MatchDetailsPlayerForm,
  MatchDetailsH2H,
  MatchDetailsH2HMeeting,
}
