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
type MatchDetailsH2H = components['schemas']['MatchDetailsH2H']
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
}
