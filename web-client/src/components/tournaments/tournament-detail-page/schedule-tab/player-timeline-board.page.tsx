import { render, screen, within, type Container } from '@/test/utilities'

import {
  PlayerTimelineBoard,
  type PlayerTimelineBoardProps,
} from './player-timeline-board'
import { buildPlayerTimelineBoardProps } from './player-timeline-board.factory'
import { timelineBarPage } from './timeline-bar.page'

const scoped = (container: Container) => ({
  queryBoard() {
    return container.queryByTestId('schedule-player-timeline')
  },
  getBoard() {
    return container.getByTestId('schedule-player-timeline')
  },
  /** The horizontally-scrolling region — labelled and keyboard-focusable. */
  getScrollRegion() {
    return container.getByRole('region', { name: 'Schedule by player' })
  },
  /** One player's row, by user id. */
  getRow(userId: string) {
    return container.getByTestId(`player-row-${userId}`)
  },
  queryRow(userId: string) {
    return container.queryByTestId(`player-row-${userId}`)
  },
  /** The player rows' usernames, top to bottom. */
  rowNames(): string[] {
    return container
      .queryAllByTestId(/^player-row-/)
      .map((el: HTMLElement) => el.querySelector('span')?.textContent ?? '')
  },
  /** One row's bars — the SAME fixture appears on both players' rows, so bar
   * queries must be scoped to a row, never global. */
  barsIn(userId: string) {
    return timelineBarPage.within(within(this.getRow(userId)))
  },
  /** The fixture ids of one row's bars, in DOM (time) order. */
  barIdsIn(userId: string): string[] {
    return within(this.getRow(userId))
      .queryAllByTestId(/^timeline-bar-/)
      .map((el) => el.getAttribute('data-testid')!.replace('timeline-bar-', ''))
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/**
 * Test page-object for `PlayerTimelineBoard`. Pure display, no fetching.
 * Tooltips portal to the body: focus via `barsIn(userId).focusBar(...)`, then
 * `findTooltip()`.
 */
export const playerTimelineBoardPage = {
  render(overrides: Partial<PlayerTimelineBoardProps> = {}) {
    render(<PlayerTimelineBoard {...buildPlayerTimelineBoardProps(overrides)} />)
  },

  findTooltip: timelineBarPage.findTooltip,


  ...scoped(screen),
}
