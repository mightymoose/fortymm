import { TooltipProvider } from '@/components/ui/tooltip'
import { fireEvent, render, screen, type Container } from '@/test/utilities'

import { TimelineBar, type TimelineBarProps } from './timeline-bar'
import { buildTimelineBarProps } from './timeline-bar.factory'

const scoped = (container: Container) => ({
  /** The bar button, by its fixture id. In a player-timeline test, scope with
   * `within(row)` first — the same fixture legitimately appears on both
   * players' rows. */
  getBar(fixtureId: string) {
    return container.getByTestId(`timeline-bar-${fixtureId}`)
  },
  queryBar(fixtureId: string) {
    return container.queryByTestId(`timeline-bar-${fixtureId}`)
  },
  /** Every bar in the scope, in DOM order. */
  queryAllBars() {
    return container.queryAllByTestId(/^timeline-bar-/)
  },
  /** The bar's tier as encoded for styling/tests — `estimate` / `called` /
   * `started`. */
  getTier(fixtureId: string) {
    return this.getBar(fixtureId).getAttribute('data-tier')
  },
  /** Focus a bar the way a keyboard reader reaches it — which also opens its
   * tooltip (radix opens on focus). */
  focusBar(fixtureId: string) {
    fireEvent.focus(this.getBar(fixtureId))
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/**
 * Test page-object for `TimelineBar`.
 *
 * `render` supplies the `TooltipProvider` + a positioned track the absolute bar
 * needs (in the app the board provides both). The tooltip is portalled to the
 * body, so `findTooltip` queries the whole screen, not the track.
 */
export const timelineBarPage = {
  render(overrides: Partial<TimelineBarProps> = {}) {
    render(
      <TooltipProvider>
        <div className="relative h-11">
          <TimelineBar {...buildTimelineBarProps(overrides)} />
        </div>
      </TooltipProvider>,
    )
  },

  /** The open tooltip (`role="tooltip"`), wherever it portalled to. */
  async findTooltip() {
    return screen.findByRole('tooltip')
  },
  queryTooltip() {
    return screen.queryByRole('tooltip')
  },


  ...scoped(screen),
}
