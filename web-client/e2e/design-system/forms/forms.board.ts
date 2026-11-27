import { type Locator } from '@playwright/test'
import { type ControlRole, type Margins } from '../locators.ts'

// The examples on the Forms board, by test id.
export type FormsExample =
  | 'ex-text-field'
  | 'ex-code-input'
  | 'ex-combobox'
  | 'ex-date-picker'
  | 'ex-checkbox-radio-and-switch'
  | 'ex-tabs'
  | 'ex-segmented'
  | 'ex-filter-chips'
  | 'ex-switch'

// The roles of the choice controls on the Forms board.
export type ChoiceRole = 'checkbox' | 'radio' | 'switch'

type Area = { x: number; y: number; width: number; height: number }

// The Forms board: Forms.dc.html in the reference, /design-system/forms in the app.
export interface FormsBoard {
  goto(): Promise<void>
  readonly fieldsAndChoicesHeading: Locator
  readonly selectionHeading: Locator
  example(testId: FormsExample): Locator
  // A field in an example, whole (label, control and help or error), by its control's name.
  field(example: FormsExample, name: string): Locator
  // A code input in an example, whole, by its name and its place among those with that name.
  codeInput(example: FormsExample, name: string, index: number): Locator
  // A combobox field in an example, whole, by its placeholder.
  comboBoxField(example: FormsExample, placeholder: string): Locator
  // A date field in an example, whole, by its name; and the calendar in an example, whole.
  dateField(example: FormsExample, name: string): Locator
  calendar(example: FormsExample): Locator
  // The open combobox in an example and its list paint past their boxes (the focus ring, the list's
  // shadow), so they are captured as page areas.
  findOpenComboBoxArea(example: FormsExample, margins: Margins): Promise<Area>
  findListBoxArea(example: FormsExample, margins: Margins): Promise<Area>
  // A choice in an example, whole, by its control's role and name: a checkbox's or radio's label
  // (which holds the input), or a switch.
  choice(example: FormsExample, role: ChoiceRole, name: string): Locator
  // The range field in an example, whole. Found by its slider: its name differs between the board
  // (the whole label, value included) and the app (the label alone).
  rangeField(example: FormsExample): Locator
  // A control in an example that is its own whole, by its role and name: a tab, a segmented
  // control's option, a filter chip, a switch.
  control(example: FormsExample, role: ControlRole, name: string): Locator
  readonly formsPage: Locator
}
