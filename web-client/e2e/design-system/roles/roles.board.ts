import { type Locator } from '@playwright/test'

// The Roles board: Roles.dc.html in the reference, /design-system/roles in the app.
export interface RolesBoard {
  goto(): Promise<void>
  readonly rolesAtAGlanceHeading: Locator
  readonly buttonsHeading: Locator
}
