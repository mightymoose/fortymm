import { type Locator } from '@playwright/test'

// The Forms board: Forms.dc.html in the reference, /design-system/forms in the app.
export interface FormsBoard {
  goto(): Promise<void>
  readonly fieldsAndChoicesHeading: Locator
  readonly selectionHeading: Locator
}
