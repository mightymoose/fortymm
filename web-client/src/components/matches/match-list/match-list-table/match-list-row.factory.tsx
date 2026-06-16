import { vi } from 'vitest'

import { matchDetailRoute } from '@/api/matches'

import type { MatchListRowProps, MatchListRowView } from './match-list-row'
import type { NavigateFn } from '../match-list-status'
import { buildPlayerChipView } from './match-list-row/player-chip.factory'
import { buildScoreCellView } from './match-list-row/score-cell.factory'
import { buildStatusBadgeView } from './match-list-row/status-badge.factory'
import { buildTimeCellView } from './match-list-row/time-cell.factory'

/**
 * A final, viewer-won singles row: rita.kovac (winner) vs nguyen.t, showing a
 * final 2–1 score, no action button (`action: null`). The default still mounts
 * under the router harness (the row click + detail link), but renders without
 * the action-Link branch.
 */
export function buildMatchListRowView(
  overrides: Partial<MatchListRowView> = {},
): MatchListRowView {
  return {
    id: 'm-1',
    shortLabel: 'M-0000M1',
    isLive: false,
    ariaLabel: 'Open match: rita.kovac vs nguyen.t',
    side1: buildPlayerChipView({ name: 'rita.kovac', isWinner: true }),
    side2: buildPlayerChipView({ name: 'nguyen.t' }),
    score: buildScoreCellView(),
    status: buildStatusBadgeView(),
    time: buildTimeCellView(),
    detailRoute: matchDetailRoute('m-1'),
    action: null,
    ...overrides,
  }
}

/** Props for `MatchListRow` — a final, viewer-won singles row plus a `navigate`
 * spy. */
export function buildMatchListRowProps(
  overrides: Partial<MatchListRowProps> = {},
): MatchListRowProps {
  return {
    row: buildMatchListRowView(),
    navigate: vi.fn() as unknown as NavigateFn,
    ...overrides,
  }
}
