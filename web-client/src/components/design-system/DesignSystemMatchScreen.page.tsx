import { screen } from '@testing-library/react'

// Page object for the design system's Match screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemMatchScreenPage {
  get matchComponentsHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Match components' })
  }
}
