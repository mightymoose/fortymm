import type { Locator, Page } from '@playwright/test'
import { DataDisplaySection } from './designSystem/DataDisplaySection.ts'
import { FeedbackSection } from './designSystem/FeedbackSection.ts'
import { FormsSection } from './designSystem/FormsSection.ts'
import { NavigationSection } from './designSystem/NavigationSection.ts'
import { OverlaysSection } from './designSystem/OverlaysSection.ts'

// Page object for the design system page in the Playwright suite: the page
// chrome, plus one object per section for its cards.
export class DesignSystemPage {
  readonly page: Page
  readonly loadingScreen: Locator
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator
  readonly intro: Locator
  readonly cards: Locator
  readonly forms: FormsSection
  readonly display: DataDisplaySection
  readonly nav: NavigationSection
  readonly overlays: OverlaysSection
  readonly feedback: FeedbackSection

  constructor(page: Page) {
    this.page = page
    this.loadingScreen = page.getByRole('status', { name: 'Loading FortyMM' })
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
    // The paragraph right after the header.
    this.intro = page.getByRole('paragraph').first()
    // Every section's component cards, whose titles are h3s. The demo cards
    // inside the Card card are articles too, with h4 titles.
    this.cards = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { level: 3 }) })
    this.forms = new FormsSection(page)
    this.display = new DataDisplaySection(page)
    this.nav = new NavigationSection(page)
    this.overlays = new OverlaysSection(page)
    this.feedback = new FeedbackSection(page)
  }

  // A component card's title, in its header.
  cardTitle(card: Locator): Locator {
    return card.getByRole('heading', { level: 3 })
  }

  // A component card's mono tag, beside its title.
  cardTag(card: Locator): Locator {
    return card.locator('.tag')
  }

  // Opens the page. It shows no loading screen, so there's nothing to wait
  // out.
  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }
}
