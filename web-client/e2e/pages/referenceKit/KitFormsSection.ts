import type { Locator, Page } from '@playwright/test'
import { KitSectionObject } from './KitSectionObject.ts'

// The reference kit's Forms & Input section.
export class KitFormsSection extends KitSectionObject {
  readonly buttonCard: Locator
  readonly inputCard: Locator
  readonly textareaCard: Locator
  readonly otpCard: Locator
  readonly checkboxCard: Locator
  readonly radioCard: Locator
  readonly switchCard: Locator
  readonly sliderCard: Locator
  readonly selectCard: Locator
  readonly comboboxCard: Locator
  readonly datePickerCard: Locator
  readonly toggleCard: Locator
  readonly textarea: Locator

  constructor(page: Page) {
    super(page, 'forms')
    this.buttonCard = this.card('Button')
    this.inputCard = this.card('Input · Label · Form Field')
    this.textareaCard = this.card('Textarea')
    this.otpCard = this.card('Input OTP')
    this.checkboxCard = this.card('Checkbox')
    this.radioCard = this.card('Radio Group')
    this.switchCard = this.card('Switch')
    this.sliderCard = this.card('Slider')
    this.selectCard = this.card('Select')
    this.comboboxCard = this.card('Combobox')
    this.datePickerCard = this.card('Date Picker')
    this.toggleCard = this.card('Toggle · Toggle Group')
    // The kit's label isn't tied to its textarea, so take the card's only
    // textarea.
    this.textarea = this.textareaCard.locator('textarea')
  }

  // The input card's input in the field labelled `name`. The kit's labels
  // aren't tied to their inputs, so find the field by its label's text.
  input(name: string): Locator {
    return this.inputCard
      .locator('.form-field')
      .filter({ has: this.page.locator('label', { hasText: name }) })
      .locator('input')
  }
}
