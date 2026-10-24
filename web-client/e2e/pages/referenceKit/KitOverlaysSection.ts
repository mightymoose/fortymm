import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference kit's Overlays section.
export class KitOverlaysSection extends KitSectionObject {
  readonly dialogCard: Locator
  readonly sheetCard: Locator
  readonly drawerCard: Locator
  readonly popoverCard: Locator
  readonly tooltipCard: Locator
  readonly hoverCardCard: Locator
  readonly menuCard: Locator
  readonly commandCard: Locator

  constructor(page: Page) {
    super(page, 'overlays')
    this.dialogCard = this.card('Dialog · Alert Dialog')
    this.sheetCard = this.card('Sheet')
    this.drawerCard = this.card('Drawer')
    this.popoverCard = this.card('Popover')
    this.tooltipCard = this.card('Tooltip')
    this.hoverCardCard = this.card('Hover Card')
    this.menuCard = this.card('Dropdown Menu · Context Menu')
    this.commandCard = this.card('Command')
  }
}
