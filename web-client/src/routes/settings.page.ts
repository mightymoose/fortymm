import { screen, within } from '@testing-library/react'
import { renderRoute } from '../test/render-route.tsx'

// The account settings page (src/routes/settings.tsx): how to open it, and
// what a person sees on it.
export class SettingsPage {
  render() {
    return renderRoute('/settings')
  }

  heading() {
    return screen.findByRole('heading', { name: 'Account settings' })
  }

  // The stored user's username: the paragraph in the region named
  // "Username".
  async username() {
    const region = await screen.findByRole('region', { name: 'Username' })
    return within(region).getByRole('paragraph')
  }

  noAccount() {
    return screen.findByRole('heading', { name: 'No account yet' })
  }

  storageUnavailable() {
    return screen.findByRole('heading', { name: 'Can’t read this device’s storage' })
  }
}
