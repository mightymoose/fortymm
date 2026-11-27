import { type Locator } from '@playwright/test'

// The Overlays board: Overlays.dc.html in the reference, /design-system/overlays in the app.
export interface OverlaysBoard {
  goto(): Promise<void>
  readonly overlaysHeading: Locator
}
