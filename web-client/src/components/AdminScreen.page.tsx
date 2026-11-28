import { screen } from '@testing-library/react'

// Page object for the admin screen, at /admin.
// Construct one after rendering the whole app (see App.page.tsx).
export class AdminScreenPage {
  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'Admin' })
  }

  // Waits for the screen to appear, e.g. after following a link to it.
  findHeading() {
    return screen.findByRole('heading', { level: 1, name: 'Admin' })
  }
}
