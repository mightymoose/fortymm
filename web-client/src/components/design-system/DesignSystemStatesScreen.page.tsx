import { screen } from '@testing-library/react'

// Page object for the design system's States screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemStatesScreenPage {
  get stateMatrixHeading() {
    return screen.getByRole('heading', { level: 2, name: 'State matrix' })
  }
}
