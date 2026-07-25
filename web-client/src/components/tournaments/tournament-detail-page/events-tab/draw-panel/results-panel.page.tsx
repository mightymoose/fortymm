import { render, screen, type Container } from '@/test/utilities'

import { ResultsPanel, type ResultsPanelProps } from './results-panel'
import { buildResultsPanelProps } from './results-panel.factory'

const scoped = (container: Container) => ({
  /** The standings block, by event id — present only when the results are the `standings`
   * arm. `query…` because its absence is what the finishes/no-results cases assert. */
  queryStandingsPanel(eventId: string) {
    return container.queryByTestId(`standings-panel-${eventId}`)
  },

  /** The finishes block, by event id — present only when the results are the `finishes`
   * arm. `query…` for the same reason. */
  queryFinishesPanel(eventId: string) {
    return container.queryByTestId(`finishes-panel-${eventId}`)
  },
})

/** Test page-object for `ResultsPanel`. */
export const resultsPanelPage = {
  render(overrides: Partial<ResultsPanelProps> = {}) {
    render(<ResultsPanel {...buildResultsPanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
