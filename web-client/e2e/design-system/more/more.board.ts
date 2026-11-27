import { type Locator } from '@playwright/test'

// The More board: More.dc.html in the reference, /design-system/more in the app.
export interface MoreBoard {
  goto(): Promise<void>
  readonly moreComponentsHeading: Locator
}
