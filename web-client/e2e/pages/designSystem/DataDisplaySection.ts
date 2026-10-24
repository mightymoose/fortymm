import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The design system page's Data Display section.
export class DataDisplaySection extends SectionObject {
  readonly cardCard: Locator
  readonly badgeCard: Locator
  readonly liveDot: Locator
  readonly avatarCard: Locator
  readonly avatarGroup: Locator
  readonly tableCard: Locator
  readonly standingsTable: Locator
  readonly progressCard: Locator
  readonly skeletonCard: Locator
  readonly skeleton: Locator
  readonly aspectRatioCard: Locator

  constructor(page: Page) {
    super(page, 'Data Display')
    this.cardCard = this.region.getByRole('article', {
      name: 'Card',
      exact: true,
    })
    this.badgeCard = this.region.getByRole('article', {
      name: 'Badge',
      exact: true,
    })
    // The dot is hidden from assistive tech, so it has no role to find it by.
    this.liveDot = this.badgeCard.locator('.ball-dot')
    this.avatarCard = this.region.getByRole('article', {
      name: 'Avatar',
      exact: true,
    })
    this.avatarGroup = this.avatarCard.getByRole('group', { name: 'Players' })
    this.tableCard = this.region.getByRole('article', {
      name: 'Table · Data Table',
      exact: true,
    })
    this.standingsTable = this.tableCard.getByRole('table', {
      name: 'Standings',
    })
    this.progressCard = this.region.getByRole('article', {
      name: 'Progress',
      exact: true,
    })
    this.skeletonCard = this.region.getByRole('article', {
      name: 'Skeleton',
      exact: true,
    })
    // The placeholders are hidden from assistive tech, so they have no role
    // to find them by.
    this.skeleton = this.skeletonCard.locator('.skeleton').first()
    this.aspectRatioCard = this.region.getByRole('article', {
      name: 'Aspect Ratio',
      exact: true,
    })
  }

  // The Card card's demo card titled `name`, e.g. "April Spring Open".
  demoCard(name: string): Locator {
    return this.cardCard.getByRole('article', { name, exact: true })
  }

  // The Badge card's badge reading `text`, e.g. "Seed 1".
  badge(text: string): Locator {
    return this.badgeCard.getByText(text, { exact: true })
  }

  // The Avatar card's avatars named `name`, e.g. "Tien Nguyen". Each name is
  // in both the row and the group.
  avatars(name: string): Locator {
    return this.avatarCard.getByRole('img', { name, exact: true })
  }

  // The Aspect Ratio card's box that reads `text`, e.g. "16 : 9".
  aspectRatioBox(text: string): Locator {
    return this.aspectRatioCard.getByText(text, { exact: true })
  }
}
