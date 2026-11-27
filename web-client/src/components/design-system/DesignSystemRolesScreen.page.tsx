import { screen } from '@testing-library/react'

// Page object for the design system's Roles screen. Construct one after rendering the whole app
// (see App.page.tsx) to query the screen the router shows.
export class DesignSystemRolesScreenPage {
  get rolesAtAGlanceHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Roles at a glance' })
  }

  get buttonsHeading() {
    return screen.getByRole('heading', { level: 2, name: 'Buttons' })
  }
}
