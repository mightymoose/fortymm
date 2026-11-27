import { type Locator } from '@playwright/test'

// The Main board: Main.dc.html in the reference, /design-system in the app.
export interface MainBoard {
  goto(): Promise<void>
  readonly heading: Locator
  readonly foundationsHeading: Locator
  readonly foundationsLink: Locator
  readonly rolesLink: Locator
  readonly formsLink: Locator
  readonly containersLink: Locator
  readonly overlaysLink: Locator
  readonly matchLink: Locator
  readonly moreLink: Locator
  readonly statesLink: Locator
}
