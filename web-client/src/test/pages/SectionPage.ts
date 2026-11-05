import { screen } from '@testing-library/react'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the pages that so far have only a title: Matches and
// Players.
export class SectionPage {
  static async render(path: '/matches' | '/players'): Promise<SectionPage> {
    return new SectionPage(await renderRoute(path))
  }

  private readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // The router's current path, e.g. `/` after a redirect.
  get path(): string {
    return this.router.state.location.pathname
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The sidebar's link named `name`.
  link(name: string): HTMLElement {
    return screen.getByRole('link', { name })
  }
}
