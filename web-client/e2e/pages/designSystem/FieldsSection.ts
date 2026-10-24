import type { Locator, Page } from '@playwright/test'
import { SectionObject } from './SectionObject.ts'

// The Fields and choices section, with its controls found by the gallery's
// test ids and their roles. The combobox's list and the calendar popup
// show over the page, past their examples.
export class FieldsSection extends SectionObject {
  readonly textField: Locator
  readonly codeInput: Locator
  readonly combobox: Locator
  readonly datePicker: Locator
  readonly choices: Locator
  readonly table: Locator
  readonly code: Locator
  readonly opponent: Locator
  readonly opponentList: Locator
  readonly date: Locator
  readonly calendarButton: Locator
  readonly calendar: Locator
  readonly inlineCalendar: Locator

  constructor(page: Page) {
    super(page, 'forms')
    this.textField = this.example('ex-text-field')
    this.codeInput = this.example('ex-code-input')
    this.combobox = this.example('ex-combobox')
    this.datePicker = this.example('ex-date-picker')
    this.choices = this.example('ex-checkbox-radio-and-switch')
    this.table = this.textField.getByRole('textbox', { name: 'Table', exact: true })
    this.code = page.getByTestId('code-input')
    this.opponent = page.getByTestId('combobox-opponent').getByRole('combobox')
    this.opponentList = page.getByTestId('combobox-opponent').getByRole('listbox')
    const dateField = page.getByTestId('datepicker-field')
    this.date = dateField.getByRole('textbox')
    this.calendarButton = dateField.getByRole('button', { name: 'Open calendar' })
    this.calendar = dateField.getByRole('dialog', { name: 'Choose date' })
    this.inlineCalendar = page.getByTestId('datepicker-inline')
  }

  // The code input's box `n`, counting from 1.
  codeBox(n: number): Locator {
    return this.code.getByRole('textbox', { name: `Character ${n} of 6` })
  }

  // The day named `name` in the calendar popup, e.g. "Sunday 12 April 2026".
  day(name: string): Locator {
    return this.calendar.getByRole('button', { name, exact: true })
  }

  // The section's control named `name` with the role `role`, e.g. the
  // switch "Call players automatically".
  control(role: 'checkbox' | 'radio' | 'switch', name: string): Locator {
    return this.choices.getByRole(role, { name, exact: true })
  }

  // Types `code` into the code input from its first box, a key at a time.
  async typeCode(code: string): Promise<void> {
    await this.codeBox(1).click()
    await this.page.keyboard.type(code)
  }

  // Types `query` into the opponent field and waits for its list.
  async searchOpponent(query: string): Promise<void> {
    await this.opponent.fill(query)
    await this.opponentList.waitFor()
  }

  // Opens the calendar with Enter on its button, as TESTING.md's example
  // does, so the focused day shows its keyboard focus ring.
  async openCalendar(): Promise<void> {
    await this.calendarButton.press('Enter')
    await this.calendar.waitFor()
  }
}
