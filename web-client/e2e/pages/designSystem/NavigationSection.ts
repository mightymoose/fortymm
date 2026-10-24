import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The design system page's Navigation section.
export class NavigationSection extends SectionObject {
  readonly tabsCard: Locator
  readonly tabList: Locator
  readonly tabPanel: Locator
  readonly accordionCard: Locator
  readonly breadcrumbCard: Locator
  readonly breadcrumb: Locator
  readonly paginationCard: Locator
  readonly pagination: Locator
  readonly navMenuCard: Locator
  readonly navMenuPanel: Locator
  readonly menubarCard: Locator
  readonly menubar: Locator

  constructor(page: Page) {
    super(page, 'Navigation')
    this.tabsCard = this.region.getByRole('article', {
      name: 'Tabs',
      exact: true,
    })
    this.tabList = this.tabsCard.getByRole('tablist', { name: 'Tournament' })
    // The chosen tab's panel: the others are hidden.
    this.tabPanel = this.tabsCard.getByRole('tabpanel')
    this.accordionCard = this.region.getByRole('article', {
      name: 'Accordion',
      exact: true,
    })
    this.breadcrumbCard = this.region.getByRole('article', {
      name: 'Breadcrumb',
      exact: true,
    })
    this.breadcrumb = this.breadcrumbCard.getByRole('navigation', {
      name: 'Breadcrumb',
    })
    this.paginationCard = this.region.getByRole('article', {
      name: 'Pagination',
      exact: true,
    })
    this.pagination = this.paginationCard.getByRole('navigation', {
      name: 'Pagination',
    })
    this.navMenuCard = this.region.getByRole('article', {
      name: 'Navigation Menu',
      exact: true,
    })
    this.navMenuPanel = this.navMenuCard.getByRole('list', { name: 'Product' })
    this.menubarCard = this.region.getByRole('article', {
      name: 'Menubar',
      exact: true,
    })
    this.menubar = this.menubarCard.getByRole('menubar', { name: 'App' })
  }

  // The Tabs card's tab named `name`, e.g. "Overview".
  tab(name: string): Locator {
    return this.tabList.getByRole('tab', { name, exact: true })
  }

  // The Accordion card's button that opens the question `name`.
  accordionTrigger(name: string): Locator {
    return this.accordionCard.getByRole('button', { name, exact: true })
  }

  // The Accordion card's answer to the question `name`, once it's open.
  accordionContent(name: string): Locator {
    return this.accordionCard.getByRole('region', { name, exact: true })
  }

  // The chevron beside the question `name`. It's hidden from assistive
  // tech, so it has no role to find it by.
  accordionChevron(name: string): Locator {
    return this.accordionTrigger(name).locator('.accordion-chevron')
  }

  // The breadcrumb's link named `name`, e.g. "Tournaments".
  breadcrumbLink(name: string): Locator {
    return this.breadcrumb.getByRole('link', { name, exact: true })
  }

  // The pagination's button named `name`, e.g. "Page 2" or "Next page".
  paginationButton(name: string): Locator {
    return this.pagination.getByRole('button', { name, exact: true })
  }

  // The navigation menu panel's link titled `title`, e.g. "Club tools".
  navMenuLink(title: string): Locator {
    return this.navMenuPanel.getByRole('link').filter({ hasText: title })
  }

  // The menubar's item named `name`, e.g. "File".
  menubarItem(name: string): Locator {
    return this.menubar.getByRole('menuitem', { name, exact: true })
  }
}
