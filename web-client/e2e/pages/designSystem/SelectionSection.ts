import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Selection section. It has no examples, so the gallery gives its four
// controls no test ids: each control's cell is found by its h4, and the
// controls by their roles and names inside the section, since the Fields
// and choices section has a switch of the same name.
export class SelectionSection extends SectionObject {
  readonly tabsCell: Locator
  readonly segmentedCell: Locator
  readonly chipsCell: Locator
  readonly switchCell: Locator
  // The panel of the selected tab, the only one that shows.
  readonly tabPanel: Locator
  // The line under the chips that says which events they show.
  readonly showing: Locator
  readonly callPlayers: Locator

  constructor(page: Page) {
    super(page, 'selection')
    this.tabsCell = this.cell('Tabs')
    this.segmentedCell = this.cell('Segmented control')
    this.chipsCell = this.cell('Filter chips')
    this.switchCell = this.cell('Switch')
    this.tabPanel = this.region.getByRole('tabpanel')
    this.showing = this.chipsCell.getByText(/^Showing:/)
    this.callPlayers = this.region.getByRole('switch', {
      name: 'Call players automatically',
    })
  }

  // The grid cell of the control named `name` by its h4, e.g. "Tabs".
  private cell(name: string): Locator {
    return this.region.getByRole('heading', { level: 4, name, exact: true }).locator('..')
  }

  // The tab named `name`, e.g. "Schedule".
  tab(name: string): Locator {
    return this.region.getByRole('tab', { name, exact: true })
  }

  // The segmented control's option named `name`, e.g. "By player".
  option(name: string): Locator {
    return this.region.getByRole('radio', { name, exact: true })
  }

  // The filter chip named `name`, e.g. "Under 18".
  chip(name: string): Locator {
    return this.chipsCell.getByRole('button', { name, exact: true })
  }
}
