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
  readonly sliderCard: Locator
  readonly selectCard: Locator
  readonly comboboxCard: Locator
  readonly combobox: Locator
  readonly comboboxBox: Locator
  readonly comboboxInputRow: Locator
  readonly comboboxIcon: Locator
  readonly comboboxOptions: Locator
  readonly datePickerCard: Locator
  readonly datePicker: Locator
  readonly datePickerLabel: Locator
  readonly datePickerTrigger: Locator
  readonly datePickerIcon: Locator
  readonly datePickerDialog: Locator
  readonly datePickerGrid: Locator
  readonly previousMonth: Locator
  readonly nextMonth: Locator

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
    this.sliderCard = this.formsSection.getByRole('article', { name: 'Slider' })
    this.selectCard = this.formsSection.getByRole('article', { name: 'Select' })
    this.comboboxCard = this.formsSection.getByRole('article', {
      name: 'Combobox',
    })
    this.combobox = this.comboboxCard.getByRole('combobox', {
      name: 'Find a player',
    })
    // The .cmd box around the input and its list, which draws the border.
    this.comboboxBox = this.comboboxCard.locator('.cmd')
    // The box's top row: the search icon and the input.
    this.comboboxInputRow = this.comboboxBox.locator('.cmd-input')
    this.comboboxIcon = this.comboboxInputRow.locator('svg')
    this.comboboxOptions = this.comboboxCard.getByRole('option')
    this.datePickerCard = this.formsSection.getByRole('article', {
      name: 'Date Picker',
    })
    // The picker's root, which the card lays out as the kit's row.
    this.datePicker = this.datePickerCard.locator('.date-picker')
    this.datePickerLabel = this.datePickerCard.getByText('Match date', {
      exact: true,
    })
    // Its name starts with the label, then the chosen date.
    this.datePickerTrigger = this.datePickerCard.getByRole('button', {
      name: /^Match date/,
    })
    this.datePickerIcon = this.datePickerTrigger.locator('svg')
    this.datePickerDialog = this.datePickerCard.getByRole('dialog', {
      name: 'Match date',
    })
    // Named by the month it shows.
    this.datePickerGrid = this.datePickerDialog.getByRole('grid')
    this.previousMonth = this.datePickerDialog.getByRole('button', {
      name: 'Previous month',
    })
    this.nextMonth = this.datePickerDialog.getByRole('button', {
      name: 'Next month',
    })
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

  // The Slider card's slider (one input) named `name`.
  slider(name: string): Locator {
    return this.sliderCard.getByRole('slider', { name, exact: true })
  }

  // The .slider-field labelled `label`: its header, track and thumbs.
  sliderField(label: string): Locator {
    return this.sliderCard.locator('.slider-field', { hasText: label })
  }

  // The readout of the value of the slider labelled `label`.
  sliderValue(label: string): Locator {
    return this.sliderField(label).locator('output')
  }

  // The track of the slider labelled `label`.
  sliderTrack(label: string): Locator {
    return this.sliderField(label).locator('.slider-track')
  }

  // The thumb drawn for the slider named `name`, right after its input.
  sliderThumb(name: string): Locator {
    return this.slider(name).locator('xpath=following-sibling::*[1]')
  }

  // Drags the thumb drawn for the slider named `name` the way a user does:
  // presses its centre and moves the mouse to `fraction` of the track's
  // width, with plain mouse events, so it goes through on a disabled slider
  // too.
  async dragSlider(name: string, fraction: number): Promise<void> {
    const thumb = this.sliderThumb(name)
    await thumb.scrollIntoViewIfNeeded()
    const from = (await thumb.boundingBox())!
    // The .slider holding the input, as wide as its track.
    const track = (await this.slider(name).locator('xpath=..').boundingBox())!
    const y = from.y + from.height / 2
    await this.page.mouse.move(from.x + from.width / 2, y)
    await this.page.mouse.down()
    await this.page.mouse.move(track.x + track.width * fraction, y, {
      steps: 5,
    })
    await this.page.mouse.up()
  }

  // The Select card's select named `name`.
  select(name: string): Locator {
    return this.selectCard.getByRole('combobox', { name, exact: true })
  }

  // The calendar's day named `name`, e.g. "April 12, 2026".
  datePickerDay(name: string): Locator {
    return this.datePickerGrid.getByRole('gridcell', { name, exact: true })
  }

  // Clicks the middle of the text `name` in `card` with a plain mouse click.
  private async clickText(card: Locator, name: string): Promise<void> {
    const text = card.getByText(name, { exact: true })
    await text.scrollIntoViewIfNeeded()
    const box = (await text.boundingBox())!
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
  }

  // Opens the page and waits for the loading screen over it to go.
  async goto(): Promise<void> {
    await this.page.goto('/design-system')
    await this.title.waitFor()
    await this.page
      .getByRole('status', { name: 'Loading FortyMM' })
      .waitFor({ state: 'hidden' })
  }

  // The input card's text input labelled `name`.
  input(name: string): Locator {
    return this.inputCard.getByRole('textbox', { name })
  }
}
