import { type Locator } from '@playwright/test'
import { type Margins } from '../locators.ts'

// The colour swatch groups on the Foundations board.
export type SwatchGroup = 'surfaces' | 'text' | 'accent' | 'status'

// The examples on the Foundations board, by test id.
export type FoundationsExample =
  | 'found-colour-surfaces'
  | 'found-colour-text'
  | 'found-colour-accent'
  | 'found-colour-status'
  | 'found-type'
  | 'found-spacing'
  | 'found-radii-shadows'
  | 'found-status-markers'
  | 'found-icons'

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
  readonly foundationsPage: Locator
  example(testId: FoundationsExample): Locator
  swatch(group: SwatchGroup, name: string): Locator
  typeRow(name: string): Locator
  spacingRow(name: string): Locator
  radiiShadowsItem(name: string): Locator
  statusMarker(text: string): Locator
  icon(name: string): Locator
  findRadiiShadowsArea(
    name: string,
    margins: Margins,
  ): Promise<{ x: number; y: number; width: number; height: number }>
}
