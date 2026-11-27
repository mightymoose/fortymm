import { screen } from '@testing-library/react'

// Page object for the design system's Containers screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemContainersScreenPage {
  get containersHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Containers' })
  }

  get feedbackHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Feedback' })
  }
}
