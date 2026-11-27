import { screen } from '@testing-library/react'

// Page object for the design system's Forms screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemFormsScreenPage {
  get fieldsAndChoicesHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Fields and choices' })
  }

  get selectionHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Selection' })
  }
}
