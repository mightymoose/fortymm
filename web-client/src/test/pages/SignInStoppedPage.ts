import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the page Auth0's error page sends the browser to.
export class SignInStoppedPage {
  // The page starts no session, so this doesn't wait for one.
  static async render(path = '/sign-in-stopped'): Promise<SignInStoppedPage> {
    await renderRoute(path)
    return new SignInStoppedPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get homeLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Go to FortyMM' })
  }

  get signInLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Sign in again' })
  }

  // The authenticated pages' sidebar, which this page doesn't have, or null.
  get sidebar(): HTMLElement | null {
    return screen.queryByRole('navigation', { name: 'Main' })
  }
}
