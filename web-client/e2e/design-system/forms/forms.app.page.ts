import { type Locator, type Page } from '@playwright/test'
import {
  exampleCalendar,
  exampleChoice,
  exampleCodeInput,
  exampleComboBoxField,
  exampleControl,
  exampleDateField,
  exampleField,
  exampleListBox,
  exampleOpenComboBox,
  exampleRangeField,
  findAreaAround,
  type ControlRole,
  type Margins,
  sectionHeading,
} from '../locators.ts'
import { type ChoiceRole, type FormsBoard, type FormsExample } from './forms.board.ts'

// The Forms board in the app: /design-system/forms.
export class FormsAppPage implements FormsBoard {
  private readonly page: Page
  readonly fieldsAndChoicesHeading: Locator
  readonly selectionHeading: Locator
  readonly formsPage: Locator

  constructor(page: Page) {
    this.page = page
    this.fieldsAndChoicesHeading = sectionHeading(page, 'Fields and choices')
    this.selectionHeading = sectionHeading(page, 'Selection')
    this.formsPage = page.getByTestId('page-forms')
  }

  example(testId: FormsExample) {
    return this.page.getByTestId(testId)
  }

  field(example: FormsExample, name: string) {
    return exampleField(this.page, example, name)
  }

  codeInput(example: FormsExample, name: string, index: number) {
    return exampleCodeInput(this.page, example, name, index)
  }

  comboBoxField(example: FormsExample, placeholder: string) {
    return exampleComboBoxField(this.page, example, placeholder)
  }

  dateField(example: FormsExample, name: string) {
    return exampleDateField(this.page, example, name)
  }

  calendar(example: FormsExample) {
    return exampleCalendar(this.page, example)
  }

  findOpenComboBoxArea(example: FormsExample, margins: Margins) {
    return findAreaAround(this.page, exampleOpenComboBox(this.page, example), margins)
  }

  findListBoxArea(example: FormsExample, margins: Margins) {
    return findAreaAround(this.page, exampleListBox(this.page, example), margins)
  }

  choice(example: FormsExample, role: ChoiceRole, name: string) {
    return exampleChoice(this.page, example, role, name)
  }

  rangeField(example: FormsExample) {
    return exampleRangeField(this.page, example)
  }

  control(example: FormsExample, role: ControlRole, name: string) {
    return exampleControl(this.page, example, role, name)
  }

  async goto() {
    await this.page.goto('/design-system/forms')
  }
}
