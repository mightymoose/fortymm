import { buildDrawnEvent } from '../../data/seed.factory'
import type { DrawPanelProps } from './draw-panel'

/** Props for `DrawPanel` — the **drawn** U1200 Singles (round-robin, two groups, an odd
 * Group A), read by its director.
 *
 * Drawn by default because that is the state with something in it: the undrawn case is
 * one line of copy, and a bare `render()` that showed it would make the panel's whole
 * job invisible. Pass `event: buildEvent()` for the empty state, `canEdit: false` for a
 * player's view. */
export function buildDrawPanelProps(
  overrides: Partial<DrawPanelProps> = {},
): DrawPanelProps {
  return {
    tournamentId: 'bay-area-open-2026',
    event: buildDrawnEvent(),
    canEdit: true,
    ...overrides,
  }
}
