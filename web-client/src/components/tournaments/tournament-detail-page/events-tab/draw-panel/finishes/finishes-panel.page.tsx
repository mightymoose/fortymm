import { renderedHtml } from '@/test/rendered-html'
import { render, screen, within, type Container } from '@/test/utilities'

import { FinishesPanel } from './finishes-panel'
import {
  buildFinishesPanelProps,
  type FinishesPanelScenario,
} from './finishes-panel.factory'

const scoped = (container: Container) => ({
  /** The whole finishes block, by event id. `query…` because the panel renders NOTHING for
   * an event with no finishes — the assertion for that state is that this is absent. */
  getPanel(eventId: string) {
    return container.getByTestId(`finishes-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`finishes-panel-${eventId}`)
  },

  /** The panel's whole rendered DOM (React ids normalized) — the equivalence guard's
   * subject: an inline snapshot of this reds on ANY rendered change. */
  getPanelHtml(eventId: string) {
    return renderedHtml(container.getByTestId(`finishes-panel-${eventId}`))
  },

  /** The panel's landmark by its accessible name — a `<section>` with `aria-labelledby` is
   * a `region`, so this only resolves while the heading is still wired to the section.
   * (The snapshot normalizes the generated id away, so the wiring is asserted here.) */
  getRegion() {
    return container.getByRole('region', { name: 'Finishes' })
  },

  /** The champion callout, by event id — shown only once the final is decided. `query…`
   * because its absence is half of what the tests assert. */
  queryChampion(eventId: string) {
    return container.queryByTestId(`finishes-champion-${eventId}`)
  },

  /** Each placement row's `[position, player]`, top to bottom (the rendered order) — the
   * position from the `#` cell (`T3` and the like), the name from the player cell. */
  getPlacements() {
    return within(container.getByRole('table'))
      .getAllByRole('row')
      .slice(1)
      .map((row) => {
        const cells = within(row).getAllByRole('cell')
        return [
          (cells[0].textContent ?? '').trim(),
          (cells[1].textContent ?? '').trim(),
        ] as const
      })
  },

  /** One finish row, by entry id — for the champion-highlight assertion (its cell carries
   * the accent class only for position 1). */
  getRow(entryId: string) {
    return container.getByTestId(`finish-row-${entryId}`)
  },
})

/** Test page-object for `FinishesPanel`. */
export const finishesPanelPage = {
  render(overrides: FinishesPanelScenario = {}) {
    render(<FinishesPanel {...buildFinishesPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
