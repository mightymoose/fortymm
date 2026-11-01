import { screen, within } from '@testing-library/react'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page after sign-out in unit tests.
export class SignedOutPage {
  // Renders `/signed-out`, or `path`, such as one with a query. The page
  // starts no session, so this doesn't wait for one.
  static async render({ path = '/signed-out' }: { path?: string } = {}): Promise<SignedOutPage> {
    return new SignedOutPage(await renderRoute(path))
  }

  private readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // The router's current path and query, e.g. `/signed-out`.
  get href(): string {
    return this.router.state.location.href
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get signInLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Sign in' })
  }

  get guestLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Play as a guest' })
  }

  // The authenticated pages' sidebar, which this page doesn't have, or null.
  get sidebar(): HTMLElement | null {
    return screen.queryByRole('navigation', { name: 'Main' })
  }

  // The message of a sign-in that didn't finish, found by its title, or null.
  signInMessage(title: string): HTMLElement | null {
    return (
      screen.queryByRole('alert', { name: title }) ?? screen.queryByRole('status', { name: title })
    )
  }

  // The sign-in message's link that starts another sign-in.
  tryAgainLink(message: HTMLElement): HTMLElement {
    return within(message).getByRole('link', { name: 'Try again' })
  }

  // The time in the sign-in message after which the visitor can try again,
  // e.g. `Try again at 10:42`, or null.
  retryTime(message: HTMLElement): HTMLElement | null {
    return within(message).queryByText(/^Try again at/)
  }
}
