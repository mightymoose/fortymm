import { type Locator } from '@playwright/test'

// The Containers board: Containers.dc.html in the reference, /design-system/containers in the app.
export interface ContainersBoard {
  goto(): Promise<void>
  readonly containersHeading: Locator
  readonly feedbackHeading: Locator
}
