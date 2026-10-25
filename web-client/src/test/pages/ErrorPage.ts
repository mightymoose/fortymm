import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the error pages in unit tests, shown in place of the app
// when a route fails or a path matches no route.
export class ErrorPage {
  // Renders the app at `path` and waits for its error page. The test makes
  // the page fail first, e.g. by overriding the session.
  static async render(path: string): Promise<ErrorPage> {
    await renderRoute(path, { waitForSession: false })
    await screen.findByRole('button', { name: /Try again|Go back/ })
    return new ErrorPage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get homeLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Go to Home' })
  }

  // The authenticated pages' sidebar, which the error pages don't have, or
  // null.
  get sidebar(): HTMLElement | null {
    return screen.queryByRole('navigation', { name: 'Main' })
  }

  get text(): string {
    return screen.getByRole('main').textContent ?? ''
  }
}
