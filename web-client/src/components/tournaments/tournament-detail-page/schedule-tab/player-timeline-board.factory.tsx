import { buildScheduleBoard } from './gantt-board.factory'
import type { PlayerTimelineBoardProps } from './player-timeline-board'

/** Props for `PlayerTimelineBoard` — the shared three-tier morning board
 * (`buildScheduleBoard`): `player.1` and `player.4` each with two bars. */
export function buildPlayerTimelineBoardProps(
  overrides: Partial<PlayerTimelineBoardProps> = {},
): PlayerTimelineBoardProps {
  return { board: buildScheduleBoard(), ...overrides }
}
