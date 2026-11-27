import { type Locator } from '@playwright/test'

// The States board: States.dc.html in the reference, /design-system/states in the app.
export interface StatesBoard {
  goto(): Promise<void>
  readonly stateMatrixHeading: Locator
}
