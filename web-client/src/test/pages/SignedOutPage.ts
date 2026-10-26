import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the page after sign-out in unit tests.
export class SignedOutPage {
  // Renders `/signed-out` or one of its designs. The page starts no session,
  // so this doesn't wait for one.
  static async render(path = '/signed-out'): Promise<SignedOutPage> {
    await renderRoute(path, { waitForSession: false })
    return new SignedOutPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get signInLink(): HTMLElement {
    return screen.getByRole('link', { name: /^Sign in/ })
  }

  get guestLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Play as a guest' })
  }

  // The authenticated pages' sidebar, which this page doesn't have, or null.
  get sidebar(): HTMLElement | null {
    return screen.queryByRole('navigation', { name: 'Main' })
  }
}
