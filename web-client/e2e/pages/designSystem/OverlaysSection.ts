import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The design system page's Overlays section.
export class OverlaysSection extends SectionObject {
  readonly dialogCard: Locator
  readonly dialog: Locator
  readonly alertDialog: Locator
  readonly sheetCard: Locator
  readonly sheet: Locator
  readonly drawerCard: Locator
  readonly drawer: Locator
  readonly popoverCard: Locator
  readonly popover: Locator
  readonly tooltipCard: Locator
  readonly tooltipFrame: Locator
  readonly refreshButton: Locator
  readonly seedBadge: Locator
  readonly hoverCardCard: Locator
  readonly hoverCard: Locator
  readonly menuCard: Locator
  readonly dropdownMenu: Locator
  readonly contextMenu: Locator
  readonly commandCard: Locator
  readonly commandBox: Locator
  readonly commandInput: Locator
  readonly commandList: Locator

  constructor(page: Page) {
    super(page, 'Overlays')
    this.dialogCard = this.region.getByRole('article', {
      name: 'Dialog · Alert Dialog',
      exact: true,
    })
    this.dialog = this.dialogCard.getByRole('dialog', {
      name: 'Forfeit this match?',
    })
    this.alertDialog = this.dialogCard.getByRole('alertdialog', {
      name: 'Delete account',
    })
    this.sheetCard = this.region.getByRole('article', {
      name: 'Sheet',
      exact: true,
    })
    this.sheet = this.sheetCard.getByRole('dialog', { name: 'Filters' })
    this.drawerCard = this.region.getByRole('article', {
      name: 'Drawer',
      exact: true,
    })
    this.drawer = this.drawerCard.getByRole('dialog', { name: 'Quick log' })
    this.popoverCard = this.region.getByRole('article', {
      name: 'Popover',
      exact: true,
    })
    this.popover = this.popoverCard.getByRole('dialog', {
      name: 'Skill rating',
    })
    this.tooltipCard = this.region.getByRole('article', {
      name: 'Tooltip',
      exact: true,
    })
    this.tooltipFrame = this.tooltipCard.locator('.mock-bg')
    this.refreshButton = this.tooltipCard.getByRole('button', {
      name: 'Refresh',
    })
    this.seedBadge = this.tooltipCard.getByText('Seed 1', { exact: true })
    this.hoverCardCard = this.region.getByRole('article', {
      name: 'Hover Card',
      exact: true,
    })
    this.hoverCard = this.hoverCardCard.getByRole('group', {
      name: 'Tien Nguyen',
    })
    this.menuCard = this.region.getByRole('article', {
      name: 'Dropdown Menu · Context Menu',
      exact: true,
    })
    this.dropdownMenu = this.menuCard.getByRole('menu', {
      name: 'Match actions',
    })
    this.contextMenu = this.menuCard.getByRole('menu', { name: 'Bracket' })
    this.commandCard = this.region.getByRole('article', {
      name: 'Command',
      exact: true,
    })
    this.commandBox = this.commandCard.locator('.cmd')
    this.commandInput = this.commandCard.getByRole('combobox', {
      name: 'Command',
    })
    this.commandList = this.commandCard.getByRole('listbox', {
      name: 'Command',
    })
  }

  // The tooltip card's tooltip reading `text`.
  tooltip(text: string): Locator {
    return this.tooltipCard.getByRole('tooltip').filter({ hasText: text })
  }

  // The dropdown menu's item named `name`, e.g. "Rematch".
  dropdownItem(name: string): Locator {
    return this.dropdownMenu.getByRole('menuitem', { name, exact: true })
  }

  // The command palette's option named `name`, e.g. "Log a match".
  commandOption(name: string): Locator {
    return this.commandList.getByRole('option', { name, exact: true })
  }
}
