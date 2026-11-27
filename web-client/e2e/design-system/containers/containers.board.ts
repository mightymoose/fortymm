import { type Locator } from '@playwright/test'
import { type Margins, type NamedRole } from '../locators.ts'

// The examples on the Containers board, by test id.
export type ContainersExample =
  | 'ex-card'
  | 'ex-scroll-area'
  | 'ex-split-view'
  | 'ex-toast'
  | 'ex-inline-notice'
  | 'ex-warning-and-error'
  | 'ex-status-set'

type Area = { x: number; y: number; width: number; height: number }

// The Containers board: Containers.dc.html in the reference, /design-system/containers in the app.
export interface ContainersBoard {
  goto(): Promise<void>
  readonly containersHeading: Locator
  readonly feedbackHeading: Locator
  example(testId: ContainersExample): Locator
  // A named element in an example, whole, by its role and name: a card, a match row, a timeline
  // track, a labelled warning, a split view's handle (see NamedRole).
  named(example: ContainersExample, role: NamedRole, name: string): Locator
  readonly containersPage: Locator
  // A toast in ex-toast, by its message. Toasts paint a shadow past their box, so they are captured
  // as page areas.
  findToastArea(message: string, margins: Margins): Promise<Area>
  // An inline notice in ex-inline-notice, by (part of) its text.
  notice(text: string): Locator
  // An alert in ex-warning-and-error, whole, by its title.
  alert(title: string): Locator
  // A status in ex-status-set, whole (marker, heading and description), by its heading.
  status(heading: string): Locator
}
