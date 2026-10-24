import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Overlays section, and the sheets and command palette it opens. They
// show on top of the page, outside the section.
export class OverlaysSection extends SectionObject {
  readonly tooltip: Locator
  readonly dialog: Locator
  readonly menu: Locator
  readonly sheetAndDrawer: Locator
  readonly commandPalette: Locator
  readonly matchSheet: Locator
  readonly moveSheet: Locator
  readonly palette: Locator
  // Where the move sheet's example says which table the match is on.
  readonly matchTable: Locator

  constructor(page: Page) {
    super(page, 'overlays')
    this.tooltip = this.example('ex-tooltip')
    this.dialog = this.example('ex-dialog')
    this.menu = this.example('ex-menu')
    this.sheetAndDrawer = this.example('ex-sheet-and-drawer')
    this.commandPalette = this.example('ex-command-palette')
    this.matchSheet = page.getByTestId('sheet-match')
    this.moveSheet = page.getByTestId('sheet-move')
    this.palette = page.getByTestId('command-palette')
    this.matchTable = this.sheetAndDrawer.locator('.fm-notice b')
  }

  // The section's button named `name`, e.g. "Move to free table".
  button(name: string): Locator {
    return this.region.getByRole('button', { name, exact: true })
  }

  // The menu example's item named `name`, e.g. "Edit match".
  menuItem(name: string): Locator {
    return this.menu.getByRole('menuitem', { name, exact: true })
  }

  async openMatchSheet(): Promise<void> {
    await this.page.getByTestId('sheet-match-trigger').click()
    await this.matchSheet.waitFor()
  }

  async openMoveSheet(): Promise<void> {
    await this.page.getByTestId('sheet-move-trigger').click()
    await this.moveSheet.waitFor()
  }

  // The palette's search field.
  get paletteSearch(): Locator {
    return this.palette.getByRole('combobox')
  }

  // The palette's command named `name`, e.g. "Patel, Meera".
  paletteOption(name: string): Locator {
    return this.palette.getByRole('option', { name })
  }

  // Opens the palette with its trigger and types `query` into it.
  async openPalette(query = ''): Promise<void> {
    await this.page.getByTestId('palette-trigger').click()
    await this.palette.waitFor()
    if (query) await this.paletteSearch.fill(query)
  }
}
