import { type Locator } from '@playwright/test'
import { type Margins } from '../locators.ts'

// The examples on the Roles board, by test id.
export type RolesExample = 'ex-variants' | 'ex-loading-and-disabled'

// The roles at a glance on the Roles board that a screenshot can take whole, by test id.
export type RolesRole = 'role-card' | 'role-notice-examples' | 'role-warning' | 'role-error'

// The Roles board: Roles.dc.html in the reference, /design-system/roles in the app.
export interface RolesBoard {
  goto(): Promise<void>
  readonly rolesAtAGlanceHeading: Locator
  readonly buttonsHeading: Locator
  example(testId: RolesExample): Locator
  button(example: RolesExample, name: string): Locator
  link(example: RolesExample, name: string): Locator
  role(testId: RolesRole): Locator
  // The toast and the tooltip paint shadows past their boxes, so they are captured as page areas.
  readonly toast: Locator
  readonly tooltip: Locator
  findToastArea(margins: Margins): Promise<{ x: number; y: number; width: number; height: number }>
  findTooltipArea(
    margins: Margins,
  ): Promise<{ x: number; y: number; width: number; height: number }>
  readonly rolesPage: Locator
}
