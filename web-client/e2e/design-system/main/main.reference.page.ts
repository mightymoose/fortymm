import { type Locator, type Page } from '@playwright/test'
import {
  exampleElement,
  exampleImage,
  exampleItem,
  findAreaAround,
  type Margins,
  sectionHeading,
  sectionLink,
} from '../locators.ts'
import { gotoReference } from '../reference.ts'
import { type FoundationsExample, type MainBoard, type SwatchGroup } from './main.board.ts'

// The Main board in the reference: Main.dc.html.
export class MainReferencePage implements MainBoard {
  private readonly page: Page
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

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1, name: 'FortyMM component showcase' })
    this.foundationsHeading = sectionHeading(page, 'Foundations')
    this.foundationsLink = sectionLink(page, 'Foundations')
    this.rolesLink = sectionLink(page, 'Roles and buttons')
    this.formsLink = sectionLink(page, 'Fields and selection')
    this.containersLink = sectionLink(page, 'Containers and feedback')
    this.overlaysLink = sectionLink(page, 'Overlays')
    this.matchLink = sectionLink(page, 'Match components')
    this.moreLink = sectionLink(page, 'More components')
    this.statesLink = sectionLink(page, 'State matrix')
    this.foundationsPage = page.getByTestId('page-foundations')
  }

  example(testId: FoundationsExample) {
    return this.page.getByTestId(testId)
  }

  swatch(group: SwatchGroup, name: string) {
    return exampleItem(this.page, `found-colour-${group}`, name)
  }

  typeRow(name: string) {
    return exampleItem(this.page, 'found-type', name)
  }

  spacingRow(name: string) {
    return exampleItem(this.page, 'found-spacing', name)
  }

  radiiShadowsItem(name: string) {
    return exampleItem(this.page, 'found-radii-shadows', name)
  }

  statusMarker(text: string) {
    return exampleElement(this.page, 'found-status-markers', text)
  }

  icon(name: string) {
    return exampleImage(this.page, 'found-icons', name)
  }

  findRadiiShadowsArea(name: string, margins: Margins) {
    return findAreaAround(this.page, this.radiiShadowsItem(name), margins)
  }

  async goto() {
    await gotoReference(this.page, 'Main.dc.html')
  }
}
