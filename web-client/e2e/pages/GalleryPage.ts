import type { Locator, Page } from '@playwright/test'
import { ButtonsSection } from './designSystem/ButtonsSection.ts'
import { FeedbackSection } from './designSystem/FeedbackSection.ts'

// The design system gallery, as the app's /design-system or the reference
// draws it: the page chrome, plus one object per section for its examples.
// Both pages open in the reference's test mode (see its TESTING.md).
export abstract class GalleryPage {
  readonly page: Page
  readonly title: Locator
  readonly intro: Locator
  readonly buttons: ButtonsSection
  readonly feedback: FeedbackSection
  // Where raised toasts show, bottom centre, outside every section. Found
  // by its class, because the gallery's region has no name to find it by.
  readonly toasts: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    // The paragraph right after the title.
    this.intro = page.getByRole('paragraph').first()
    this.buttons = new ButtonsSection(page)
    this.feedback = new FeedbackSection(page)
    this.toasts = page.locator('.fm-toast-region')
  }

  // The button named `name` on a raised toast, e.g. "Undo".
  toastButton(name: string): Locator {
    return this.toasts.getByRole('button', { name, exact: true })
  }

  // Clicks `trigger` and waits until the toast it raises, `message`, shows.
  // Toasts stay until dismissed in test mode.
  async raiseToast(trigger: Locator, message: string): Promise<void> {
    await trigger.click()
    await this.toasts.getByText(message, { exact: true }).waitFor()
  }

  // The page's URL with `query` added.
  protected abstract url(query: string): string

  // Opens the page in test mode: no transitions, animations or text caret.
  // With `only`, it shows just the element with that test id, flush
  // top-left with 24px padding, so it starts on a whole pixel on both pages
  // whatever comes before it.
  async goto(only?: string): Promise<void> {
    await this.page.goto(
      this.url(only ? `?test&only=${encodeURIComponent(only)}` : '?test'),
    )
    // Set once the fonts have loaded and two frames have painted.
    await this.page.locator('html[data-fm-ready="true"]').waitFor()
  }
}
