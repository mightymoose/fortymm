import type { components } from '@/api/schema'

import { buildRatingChange } from './rating-change.factory'

type PlayerMatchRow = components['schemas']['PlayerMatchRow']
type PlayerMatchGame = components['schemas']['PlayerMatchGame']
type PlayerMatchListResponse = components['schemas']['PlayerMatchListResponse']

/** One game of a match, already flipped to the profiled player's perspective. */
export function buildPlayerMatchGame(
  overrides: Partial<PlayerMatchGame> = {},
): PlayerMatchGame {
  return { mine: 11, theirs: 7, ...overrides }
}

/**
 * A row of the player's match history (`PlayerMatchRow` on the wire).
 *
 * Defaults to a **completed, rated win**: three games, `result: 'W'`, and a
 * `rating_change` of +12. Every other state below is a named variant, because
 * this list is deliberately all-inclusive (ADR-0008) — live, awaiting, up-next,
 * voided, solo and unrated rows all belong in it.
 */
export function buildPlayerMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return {
    id: 'm-1',
    status: 'completed',
    created_at: '2024-03-14T09:00:00Z',
    opponent: { id: 'p-9', username: 'ada.lovelace' },
    games: [
      buildPlayerMatchGame({ mine: 11, theirs: 7 }),
      buildPlayerMatchGame({ mine: 9, theirs: 11 }),
      buildPlayerMatchGame({ mine: 11, theirs: 6 }),
    ],
    result: 'W',
    awaiting_acceptance: false,
    rating_change: buildRatingChange({ before: 1675, after: 1687, delta: 12 }),
    ...overrides,
  }
}

/** A completed, rated loss. */
export function buildLossMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-loss',
    games: [
      buildPlayerMatchGame({ mine: 8, theirs: 11 }),
      buildPlayerMatchGame({ mine: 6, theirs: 11 }),
    ],
    result: 'L',
    rating_change: buildRatingChange({ before: 1701, after: 1687, delta: -14 }),
    ...overrides,
  })
}

/**
 * A match still being played. No result, and — crucially — **no rating change**:
 * nothing has moved yet, so the row's Δ is `—`, never `+0`.
 */
export function buildLiveMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-live',
    status: 'in_progress',
    // A live match may already have games on the board; the row still refuses to
    // report a score for a match that hasn't finished.
    games: [buildPlayerMatchGame({ mine: 11, theirs: 9 })],
    result: null,
    rating_change: null,
    ...overrides,
  })
}

/**
 * A posted-but-unaccepted result. It sits at `in_progress` like a live match —
 * the `awaiting_acceptance` flag is the only thing that tells them apart (#364).
 */
export function buildAwaitingMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildLiveMatchRow({
    id: 'm-awaiting',
    awaiting_acceptance: true,
    ...overrides,
  })
}

/** A match that has been agreed but not started. */
export function buildUpNextMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-up-next',
    status: 'pending',
    games: [],
    result: null,
    rating_change: null,
    ...overrides,
  })
}

/** A voided match. It stays in the history, decides nothing and moves no rating. */
export function buildVoidedMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-voided',
    status: 'voided',
    result: null,
    rating_change: null,
    ...overrides,
  })
}

/**
 * A solo match: the player-less sentinel side the API sends for a match with no
 * opponent (ADR-0008). The row renders it as "No opponent" rather than dropping
 * the match.
 */
export function buildSoloMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-solo',
    opponent: { id: null, username: null },
    ...overrides,
  })
}

/**
 * A completed, decided win in an **unrated** match. Decided, so it has a result
 * and a score — but no rating moved, so its Δ is `—`, never `+0`.
 */
export function buildUnratedWinMatchRow(
  overrides: Partial<PlayerMatchRow> = {},
): PlayerMatchRow {
  return buildPlayerMatchRow({
    id: 'm-unrated',
    rating_change: null,
    ...overrides,
  })
}

/** The `matches` block of the profile bundle: the six most recent rows. */
export function buildPlayerMatchList(
  items: PlayerMatchRow[],
  overrides: Partial<PlayerMatchListResponse> = {},
): PlayerMatchListResponse {
  return {
    items,
    page: 1,
    page_size: 6,
    total: items.length,
    ...overrides,
  }
}
