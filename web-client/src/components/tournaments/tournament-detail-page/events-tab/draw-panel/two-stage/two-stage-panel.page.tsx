import { render, screen, within, type Container } from '@/test/utilities'

import { TwoStagePanel } from './two-stage-panel'
import {
  buildTwoStagePanelProps,
  type TwoStagePanelScenario,
} from './two-stage-panel.factory'

const scoped = (container: Container) => ({
  /** The whole two-stage block, by event id. */
  getPanel(eventId: string) {
    return container.getByTestId(`two-stage-panel-${eventId}`)
  },

  /** The **group stage**, rendered by the shared `StandingsPanel` — addressed by that
   * panel's own testid, which is the proof it is the shared component and not a fork. */
  queryStandingsPanel(eventId: string) {
    return container.queryByTestId(`standings-panel-${eventId}`)
  },

  /** The **knockout stage**, rendered by the shared `FinishesPanel` — same argument. */
  queryFinishesPanel(eventId: string) {
    return container.queryByTestId(`finishes-panel-${eventId}`)
  },

  /** The one champion callout this block owns. `query…` because a mid-flight event's
   * assertion is that it is absent. */
  queryChampion(eventId: string) {
    return container.queryByTestId(`two-stage-champion-${eventId}`)
  },

  /** Every champion callout on the card, whoever rendered it — the "**single** banner"
   * assertion. A sub-panel that crowned a stage of its own would show up here. */
  getAllChampions() {
    return container.queryAllByText('Champion')
  },

  /** The block's stage headings **in rendered order** — `['Standings', 'Finishes']` when
   * the groups sit above the bracket they seeded. Reading the DOM order is the only way to
   * assert "above": both sections render either way round. */
  getStageHeadings() {
    return container
      .getAllByRole('heading', { level: 3 })
      .map((h: HTMLElement) => (h.textContent ?? '').trim())
  },

  /** One group table's player names, top to bottom (the rendered order). */
  getGroupRowNames(groupLabel: string) {
    return within(container.getByRole('table', { name: `Standings for ${groupLabel}` }))
      .getAllByRole('row')
      .slice(1)
      .map((row) => (within(row).getAllByRole('cell')[1].textContent ?? '').trim())
  },

  /** The bracket's placements as `[position, player]`, top to bottom — the position label
   * (`1st`, `T3`) from the `#` cell, the name from the player cell. */
  getPlacements(eventName: string) {
    return within(container.getByRole('table', { name: `Finishes for ${eventName}` }))
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
})

/** Test page-object for `TwoStagePanel`. */
export const twoStagePanelPage = {
  render(overrides: TwoStagePanelScenario = {}) {
    render(<TwoStagePanel {...buildTwoStagePanelProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
