import { screen } from '@testing-library/react'

// Page object for the design system's Main screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemMainScreenPage {
  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'FortyMM component showcase' })
  }

  get foundationsHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Foundations' })
  }
}
