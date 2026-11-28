import { screen } from '@testing-library/react'

// Page object for the settings screen, at /settings.
// Construct one after rendering the whole app (see App.page.tsx).
export class SettingsScreenPage {
  get heading() {
    return screen.getByRole('heading', { level: 1, name: 'Settings' })
  }

  // Waits for the screen to appear, e.g. after following a link to it.
  findHeading() {
    return screen.findByRole('heading', { level: 1, name: 'Settings' })
  }
}
