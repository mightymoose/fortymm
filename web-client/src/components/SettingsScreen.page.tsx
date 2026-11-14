import { screen, within } from '@testing-library/react'
import type { Account } from '../account.ts'
import { renderScreen } from '../test/render-screen.tsx'
import { SettingsScreen, SettingsScreenPending } from './SettingsScreen.tsx'

// The account settings screen (SettingsScreen.tsx): how to render it alone,
// with the account the route's loader would hand it, or its pending view; and
// what a person sees on it. The finders work wherever the screen is mounted,
// through its route (src/routes/settings.test.tsx) too.
export class SettingsScreenPage {
  render(account: Account) {
    return renderScreen(<SettingsScreen account={account} />)
  }

  renderPending() {
    return renderScreen(<SettingsScreenPending />)
  }

  heading() {
    return screen.findByRole('heading', { name: 'Account settings' })
  }

  reading() {
    return screen.findByRole('heading', { name: 'Reading this device’s account' })
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
