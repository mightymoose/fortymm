import { screen } from '@testing-library/react'
import { renderRoute } from '../renderRoute'

// Page object for the home page in unit tests. Elements are looked up through
// `screen` on every access, so they always reflect the current render.
export class HomePage {
  static async render(
    options?: Parameters<typeof renderRoute>[1],
  ): Promise<HomePage> {
    await renderRoute('/', options)
    return new HomePage()
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The page's title, or null while the loading screen shows instead.
  get queryTitle(): HTMLElement | null {
    return screen.queryByRole('heading', { level: 1 })
  }

  // The loading screen shown in place of the page on a full page load, or
  // null once it's gone.
  get loadingScreen(): HTMLElement | null {
    return screen.queryByRole('status', { name: 'Loading FortyMM' })
  }

  get designSystemLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Design System' })
  }
}
