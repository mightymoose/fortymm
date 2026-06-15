import { scoringNewRoute } from '@/api/matches'
import type { AttentionPanelProps } from './attention-panel'
import type {
  AttentionPanelView,
  AttentionRowView,
} from './attention-panel-view'

/** One primary "Enter score" row routing to game 1's scoring page. */
export function buildAttentionRowView(
  overrides: Partial<AttentionRowView> = {},
): AttentionRowView {
  return {
    matchId: 'm-1',
    opponentName: 'nguyen.t',
    headline: 'vs nguyen.t',
    actionLabel: 'Enter score',
    primary: true,
    route: scoringNewRoute('m-1', 1),
    ...overrides,
  }
}

/** A panel with a single primary "Enter score" row, no overflow, nobody
 * waiting, and a "View all" link scoped to rita.kovac's matches. */
export function buildAttentionPanelView(
  overrides: Partial<AttentionPanelView> = {},
): AttentionPanelView {
  return {
    rows: [buildAttentionRowView()],
    overflowCount: 0,
    waitingCount: 0,
    viewAllSearch: { q: 'rita.kovac' },
    ...overrides,
  }
}

/** Props for `AttentionPanel`. */
export function buildAttentionPanelProps(
  overrides: Partial<AttentionPanelProps> = {},
): AttentionPanelProps {
  return { view: buildAttentionPanelView(), ...overrides }
}
