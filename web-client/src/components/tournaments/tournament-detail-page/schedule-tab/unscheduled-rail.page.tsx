import { render, screen, within, type Container } from '@/test/utilities'

import { UnscheduledRail, type UnscheduledRailProps } from './unscheduled-rail'
import { buildUnscheduledRailProps } from './unscheduled-rail.factory'

const scoped = (container: Container) => ({
  /** The rail section — absent (null) when every fixture is placed. */
  queryRail() {
    return container.queryByTestId('schedule-unscheduled')
  },
  getRail() {
    return container.getByTestId('schedule-unscheduled')
  },
  /** One rail item, by fixture id. */
  getItem(fixtureId: string) {
    return container.getByTestId(`unscheduled-${fixtureId}`)
  },
  /** The rail's items in order, as normalized text. */
  getItemTexts(): string[] {
    return within(this.getRail())
      .getAllByRole('listitem')
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
  },

  within(node: Container = screen) {
    return scoped(node)
  },
})

/** Test page-object for `UnscheduledRail` — the "not yet scheduled" list. */
export const unscheduledRailPage = {
  render(overrides: Partial<UnscheduledRailProps> = {}) {
    render(<UnscheduledRail {...buildUnscheduledRailProps(overrides)} />)
  },


  ...scoped(screen),
}
