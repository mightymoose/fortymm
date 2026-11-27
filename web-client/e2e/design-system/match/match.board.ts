import { type Locator } from '@playwright/test'

// The Match board: Match.dc.html in the reference, /design-system/match in the app.
export interface MatchBoard {
  goto(): Promise<void>
  readonly matchComponentsHeading: Locator
}
