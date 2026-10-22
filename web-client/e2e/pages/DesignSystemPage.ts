import type { Locator, Page } from '@playwright/test'

// Page object for the design system page in the Playwright suite.
export class DesignSystemPage {
  readonly page: Page
  readonly header: Locator
  readonly title: Locator
  readonly subtitle: Locator
  readonly intro: Locator
  readonly formsSection: Locator
  readonly formsSectionHeading: Locator
  readonly formsSectionLead: Locator
  readonly cards: Locator
  readonly buttonCard: Locator
  readonly inputCard: Locator
  readonly textareaCard: Locator
  readonly textarea: Locator
  readonly otpCard: Locator
  readonly otpInput: Locator
  readonly activeOtpCell: Locator

  constructor(page: Page) {
    this.page = page
    this.header = page.getByRole('banner')
    this.title = this.header.getByRole('heading', { level: 1 })
    this.subtitle = this.header.locator('.sub')
    // The paragraph right after the header.
    this.intro = page.getByRole('paragraph').first()
    this.formsSection = page.getByRole('region', { name: 'Forms & Input' })
    this.formsSectionHeading = this.formsSection.getByRole('heading', {
      level: 2,
    })
    this.formsSectionLead = this.formsSection.getByRole('paragraph')
    this.cards = this.formsSection.getByRole('article')
    this.buttonCard = this.formsSection.getByRole('article', { name: 'Button' })
    this.inputCard = this.formsSection.getByRole('article', {
      name: 'Input · Label · Form Field',
    })
    this.textareaCard = this.formsSection.getByRole('article', {
      name: 'Textarea',
    })
    this.textarea = this.textareaCard.getByRole('textbox', {
      name: 'Match notes',
    })
    this.otpCard = this.formsSection.getByRole('article', { name: 'Input OTP' })
    this.otpInput = this.otpCard.getByRole('textbox', {
      name: 'Verification code',
    })
    // The cells are hidden from assistive tech, so find the active one by its
    // class.
    this.activeOtpCell = this.otpCard.locator('.otp-cell--active')
  }

  // A component card's title, in its header.
  cardTitle(card: Locator): Locator {
    return card.getByRole('heading', { level: 3 })
  }

  // A component card's mono tag, beside its title.
  cardTag(card: Locator): Locator {
    return card.locator('.tag')
  }

  // The one-time code's cell at `index`.
  otpCell(index: number): Locator {
    return this.otpCard.locator('.otp-cell').nth(index)
  }

  // Clicks the cell at `index` the way a user does: the input laid over the
  // cells takes the click.
  async clickOtpCell(index: number): Promise<void> {
    const input = (await this.otpInput.boundingBox())!
    const cell = (await this.otpCell(index).boundingBox())!
    await this.otpInput.click({
      position: {
        x: cell.x - input.x + cell.width / 2,
        y: cell.y - input.y + cell.height / 2,
      },
    })
  }

  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }

  // The input card's text input labelled `name`.
  input(name: string): Locator {
    return this.inputCard.getByRole('textbox', { name })
  }
}
