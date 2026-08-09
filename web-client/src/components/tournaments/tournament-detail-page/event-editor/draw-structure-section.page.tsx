import { render, screen, within, type Container } from '@/test/utilities'

import {
  DrawStructureSection,
  type DrawStructureSectionProps,
} from './draw-structure-section'
import { buildDrawStructureSectionProps } from './draw-structure-section.factory'
import { drawPreviewPage } from './draw-structure-section/draw-preview.page'
import { settingRowPage } from './draw-structure-section/setting-row.page'

const scoped = (container: Container) => ({
  getSection() {
    return container.getByTestId('draw-structure-section')
  },
  /** The tab's heading — the one sentence that says what the tab is for. */
  getHeading() {
    return container.getByTestId('draw-structure-heading')
  },
  /** The field every number on the tab is derived from. */
  getPreviewFieldSize() {
    return container.getByTestId('draw-structure-field-size')
  },
  /** Where that field came from: the event's cap, or the honest "no cap" sentence. */
  getPreviewBasis() {
    return container.getByTestId('draw-structure-preview-basis')
  },
  /** The way back to the tab that sets the player limit. */
  getChangeInBasicsButton() {
    return container.getByRole('button', { name: 'Change in Basics' })
  },
  /** Every setting's name, **in the order the rows render** — the claim that the four
   * settings read top to bottom as Pool count, Pool size, Membership, Qualifiers per
   * pool, which no name-addressed accessor can state. */
  getSettingNames(): string[] {
    return container
      .queryAllByTestId('draw-setting-name')
      .map((node: HTMLElement) => (node.textContent ?? '').trim())
  },
  /** One setting's row, addressed by the setting it holds — the four rows are
   * otherwise identical markup. Returns the row's own accessors
   * (`settingRowPage`), scoped to it. */
  setting(name: string) {
    return settingRowPage.within(
      within(container.getByRole('region', { name })),
    )
  },
  /** The right column, which holds the live preview. */
  getPreviewSlot() {
    return container.getByTestId('draw-structure-preview-slot')
  },
  /** The live preview's own accessors (`drawPreviewPage`), scoped to the tab. The
   * preview's content is pinned by its own tests — the tab asserts it wired it in. */
  preview: drawPreviewPage.within(container),
})

/** Test page-object for `DrawStructureSection`, the event editor's fifth tab. */
export const drawStructureSectionPage = {
  render(overrides: Partial<DrawStructureSectionProps> = {}) {
    render(<DrawStructureSection {...buildDrawStructureSectionProps(overrides)} />)
  },

  within(container: Container = screen) {
    return scoped(container)
  },

  ...scoped(screen),
}
