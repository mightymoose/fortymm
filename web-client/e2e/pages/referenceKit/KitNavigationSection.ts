import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference kit's Navigation section.
export class KitNavigationSection extends KitSectionObject {
  readonly tabsCard: Locator
  readonly accordionCard: Locator
  readonly breadcrumbCard: Locator
  readonly paginationCard: Locator
  readonly navMenuCard: Locator
  readonly menubarCard: Locator

  constructor(page: Page) {
    super(page, 'nav')
    this.tabsCard = this.card('Tabs')
    this.accordionCard = this.card('Accordion')
    this.breadcrumbCard = this.card('Breadcrumb')
    this.paginationCard = this.card('Pagination')
    this.navMenuCard = this.card('Navigation Menu')
    this.menubarCard = this.card('Menubar')
  }
}
