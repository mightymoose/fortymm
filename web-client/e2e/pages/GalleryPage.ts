import type { Locator, Page } from '@playwright/test'
import { ButtonsSection } from './designSystem/ButtonsSection.ts'
import { ContainersSection } from './designSystem/ContainersSection.ts'
import { FeedbackSection } from './designSystem/FeedbackSection.ts'
import { FieldsSection } from './designSystem/FieldsSection.ts'
import { MatchSection } from './designSystem/MatchSection.ts'
import { OverlaysSection } from './designSystem/OverlaysSection.ts'
import { SelectionSection } from './designSystem/SelectionSection.ts'

// The design system gallery, as the app's /design-system or the reference
// draws it: the page chrome, plus one object per section for its examples.
// Both pages open in the reference's test mode (see its TESTING.md).
export abstract class GalleryPage {
  readonly page: Page
  readonly title: Locator
  readonly intro: Locator
  readonly buttons: ButtonsSection
  readonly fields: FieldsSection
  readonly selection: SelectionSection
  readonly containers: ContainersSection
  readonly feedback: FeedbackSection
  readonly overlays: OverlaysSection
  readonly match: MatchSection
  // Where raised toasts show, bottom centre, outside every section. Found
  // by its class, because the gallery's region has no name to find it by.
  readonly toasts: Locator
  // The page's one tooltip, on <body>, while it's shown.
  readonly shownTooltip: Locator
  // The dialog that "Withdraw player…" opens, from the Buttons section and
  // the Overlays section's Dialog example.
  readonly withdrawDialog: Locator

  constructor(page: Page) {
    this.page = page
    this.title = page.getByRole('heading', { level: 1 })
    // The paragraph right after the title.
    this.intro = page.getByRole('paragraph').first()
    this.buttons = new ButtonsSection(page)
    this.fields = new FieldsSection(page)
    this.selection = new SelectionSection(page)
    this.containers = new ContainersSection(page)
    this.feedback = new FeedbackSection(page)
    this.overlays = new OverlaysSection(page)
    this.match = new MatchSection(page)
    this.toasts = page.locator('.fm-toast-region')
    this.shownTooltip = page.getByRole('tooltip')
    this.withdrawDialog = page.getByTestId('dialog-withdraw')
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

  // Rests the pointer on `trigger` and waits for its tooltip, `text`. In
  // test mode it shows at once.
  async showTooltip(trigger: Locator, text: string): Promise<void> {
    await trigger.hover()
    await this.page.getByRole('tooltip', { name: text, exact: true }).waitFor()
  }

  // Opens the withdraw dialog with `trigger`, a "Withdraw player…" button.
  async openWithdrawDialog(trigger: Locator): Promise<void> {
    await trigger.click()
    await this.withdrawDialog.waitFor()
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
