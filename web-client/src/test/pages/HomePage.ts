import { fireEvent, screen } from '@testing-library/react'
import { navigate, renderRoute, type AppRouter } from '../renderRoute'

// Page object for the home page in unit tests. Elements are looked up through
// `screen` on every access, so they always reflect the current render.
export class HomePage {
  static async render(
    options?: Parameters<typeof renderRoute>[1],
  ): Promise<HomePage> {
    return new HomePage(await renderRoute('/', options))
  }

  private readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // Goes to another page in the same app, as a link would.
  navigate(to: '/' | '/design-system'): Promise<void> {
    return navigate(this.router, to)
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

  // The loading screen shown over the page on a slow page load, or null
  // while it isn't.
  get loadingScreen(): HTMLElement | null {
    return screen.queryByRole('status', { name: 'Loading FortyMM' })
  }

  // The router's default error message, shown in place of the page when it
  // fails to load, or null.
  get errorMessage(): HTMLElement | null {
    return screen.queryByText('Something went wrong!')
  }

  // Whether the loading screen has started to fade out. jsdom runs no CSS
  // animations, so the class is what tests can see.
  get loadingScreenFading(): boolean {
    return !!this.loadingScreen?.classList.contains('loading-screen-leaving')
  }

  // jsdom runs no CSS animations, so tests end the loading screen's fade-out
  // themselves.
  endLoadingScreenFade(): void {
    fireEvent.animationEnd(this.loadingScreen!)
  }

  // The sidebar's link to Home, or null.
  get homeLink(): HTMLElement | null {
    return screen.queryByRole('link', { name: 'Home' })
  }

  // A link to the design system page. The app has none, so this is null.
  get designSystemLink(): HTMLElement | null {
    return screen.queryByRole('link', { name: 'Design System' })
  }

  // The button that shows and hides the sidebar's labels.
  get sidebarLabelsButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Sidebar labels' })
  }
}
