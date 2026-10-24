import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference kit's Data Display section.
export class KitDataDisplaySection extends KitSectionObject {
  readonly cardCard: Locator
  readonly badgeCard: Locator
  readonly avatarCard: Locator
  readonly tableCard: Locator
  readonly progressCard: Locator
  readonly skeletonCard: Locator

  constructor(page: Page) {
    super(page, 'display')
    this.cardCard = this.card('Card')
    this.badgeCard = this.card('Badge')
    this.avatarCard = this.card('Avatar')
    this.tableCard = this.card('Table · Data Table')
    this.progressCard = this.card('Progress')
    this.skeletonCard = this.card('Skeleton')
  }
}
