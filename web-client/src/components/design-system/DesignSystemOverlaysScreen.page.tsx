import { screen } from '@testing-library/react'

// Page object for the design system's Overlays screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemOverlaysScreenPage {
  get overlaysHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Overlays' })
  }
}
