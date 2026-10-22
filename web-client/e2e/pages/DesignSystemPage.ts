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
  readonly inputCardFields: Locator
  readonly textareaCard: Locator
  readonly textarea: Locator
  readonly otpCard: Locator
  readonly otpInput: Locator
  readonly activeOtpCell: Locator
  readonly checkboxCard: Locator
  readonly radioCard: Locator
  readonly radioGroup: Locator
  readonly switchCard: Locator

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
    // The card's fields, each a label, its input and any help text.
    this.inputCardFields = this.inputCard.locator('.form-field')
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
    this.checkboxCard = this.formsSection.getByRole('article', {
      name: 'Checkbox',
    })
    this.radioCard = this.formsSection.getByRole('article', {
      name: 'Radio Group',
    })
    this.radioGroup = this.radioCard.getByRole('radiogroup', {
      name: 'Match format',
    })
    this.switchCard = this.formsSection.getByRole('article', { name: 'Switch' })
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

  // The Checkbox card's checkbox labelled `name`.
  checkbox(name: string): Locator {
    return this.checkboxCard.getByRole('checkbox', { name })
  }

  // The box that draws the checkbox labelled `name`.
  checkboxBox(name: string): Locator {
    return this.checkboxLabel(name).locator('.checkbox-box')
  }

  // The <label> holding the checkbox labelled `name` and its text.
  checkboxLabel(name: string): Locator {
    return this.checkboxCard.locator('label', { hasText: name })
  }

  // Clicks the checkbox labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden). It's a plain mouse click, so
  // it goes through on a disabled checkbox too, which Playwright's own
  // click() would wait on until it's enabled.
  async clickCheckboxLabel(name: string): Promise<void> {
    await this.clickText(this.checkboxCard, name)
  }

  // The Radio Group card's radio labelled `name`.
  radio(name: string): Locator {
    return this.radioGroup.getByRole('radio', { name })
  }

  // The dot that draws the radio labelled `name`.
  radioDot(name: string): Locator {
    return this.radioCard
      .locator('label', { hasText: name })
      .locator('.radio-dot')
  }

  // Clicks the radio labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden), with a plain mouse click, as
  // clickCheckboxLabel() does.
  async clickRadioLabel(name: string): Promise<void> {
    await this.clickText(this.radioCard, name)
  }

  // The Switch card's switch labelled `name`.
  switch(name: string): Locator {
    return this.switchCard.getByRole('switch', { name })
  }

  // The <label> row holding the switch labelled `name`, its text and track.
  switchLabel(name: string): Locator {
    return this.switchCard.locator('label', { hasText: name })
  }

  // The label text of the switch labelled `name`.
  switchText(name: string): Locator {
    return this.switchCard.getByText(name, { exact: true })
  }

  // The track that draws the switch labelled `name`.
  switchTrack(name: string): Locator {
    return this.switchLabel(name).locator('.switch-track')
  }

  // Clicks the switch labelled `name` the way a user does: on its label's
  // text (the input itself is visually hidden), with a plain mouse click, as
  // clickCheckboxLabel() does.
  async clickSwitchLabel(name: string): Promise<void> {
    await this.clickText(this.switchCard, name)
  }

  // Clicks the middle of the text `name` in `card` with a plain mouse click.
  private async clickText(card: Locator, name: string): Promise<void> {
    const text = card.getByText(name, { exact: true })
    await text.scrollIntoViewIfNeeded()
    const box = (await text.boundingBox())!
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  async goto(): Promise<void> {
    await this.page.goto('/design-system')
  }

  // The input card's text input labelled `name`.
  input(name: string): Locator {
    return this.inputCard.getByRole('textbox', { name })
  }
}
