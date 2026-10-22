import { fireEvent, screen } from '@testing-library/react'
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

  // Waits for the page's title, e.g. once the loading screen has gone.
  findTitle(): Promise<HTMLElement> {
    return screen.findByRole('heading', { level: 1 })
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

  // The router's default error message, shown in place of the page when it
  // fails to load, or null.
  get errorMessage(): HTMLElement | null {
    return screen.queryByText('Something went wrong!')
  }

  // jsdom runs no CSS animations, so tests end the loading screen's fade-out
  // themselves.
  endLoadingScreenFade(): void {
    fireEvent.animationEnd(this.loadingScreen!)
  }

  get designSystemLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Design System' })
  }
}
