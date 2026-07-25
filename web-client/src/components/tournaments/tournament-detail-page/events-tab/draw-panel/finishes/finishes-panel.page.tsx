import { render, screen, within, type Container } from '@/test/utilities'

import { FinishesPanel, type FinishesPanelProps } from './finishes-panel'
import { buildFinishesPanelProps } from './finishes-panel.factory'

const scoped = (container: Container) => ({
  /** The whole finishes block, by event id. `query…` because the panel renders NOTHING for
   * an event with no finishes — the assertion for that state is that this is absent. */
  getPanel(eventId: string) {
    return container.getByTestId(`finishes-panel-${eventId}`)
  },
  queryPanel(eventId: string) {
    return container.queryByTestId(`finishes-panel-${eventId}`)
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
  render(overrides: Partial<FinishesPanelProps> = {}) {
    render(<FinishesPanel {...buildFinishesPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
