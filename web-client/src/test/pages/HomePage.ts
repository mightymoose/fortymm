import { fireEvent, screen, within } from '@testing-library/react'
import { navigate, renderRoute, type AppRouter } from '../renderRoute'

// Page object for the home page in unit tests. Elements are looked up through
// `screen` on every access, so they always reflect the current render.
export class HomePage {
  // Renders the app at `path`, `/` by default. Another path, such as one
  // with a query, must still show the home page.
  static async render({
    path = '/',
    ...options
  }: { path?: string } & Parameters<typeof renderRoute>[1] = {}): Promise<HomePage> {
    return new HomePage(await renderRoute(path, options))
  }

  private readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // Goes to another page in the same app, as a link would.
  navigate(to: '/' | '/design-system'): Promise<void> {
    return navigate(this.router, to)
  }

  // The router's current path and query, e.g. `/?tab=1`.
  get href(): string {
    return this.router.state.location.href
  }

  // The strip that asks a guest to sign in, or null.
  get signInStrip(): HTMLElement | null {
    return screen.queryByRole('complementary', { name: 'Sign in' })
  }

  // The strip's link that signs a guest in.
  get signInLink(): HTMLElement {
    return within(this.signInStrip!).getByRole('link', { name: 'Sign in' })
  }

  // The strip that shows a verified account, or null.
  get accountStrip(): HTMLElement | null {
    return screen.queryByRole('complementary', { name: 'Your account' })
  }

  // The account strip's button that signs out.
  get signOutButton(): HTMLElement {
    return within(this.accountStrip!).getByRole('button', { name: /^Sign(ing)? out/ })
  }

  // Waits for the account strip's message that signing out failed.
  findSignOutError(): Promise<HTMLElement> {
    return within(this.accountStrip!).findByRole('alert')
  }

  // The message of a sign-in that came back with an error, found by its
  // title, or null. An error is an alert. A cancelled sign-in is a status.
  signInMessage(title: string): HTMLElement | null {
    return (
      screen.queryByRole('alert', { name: title }) ?? screen.queryByRole('status', { name: title })
    )
  }

  // The sign-in message's link that starts another sign-in.
  tryAgainLink(message: HTMLElement): HTMLElement {
    return within(message).getByRole('link', { name: 'Try again' })
  }

  // The sign-in message's button that hides it.
  dismissButton(message: HTMLElement): HTMLElement {
    return within(message).getByRole('button', { name: 'Dismiss' })
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // Each part of FortyMM on the roadmap as its name and stage, in the order
  // listed.
  get parts(): { name: string; stage: string }[] {
    return within(screen.getByRole('list')).getAllByRole('listitem').map((part) => ({
      name: within(part).getByRole('heading', { level: 2 }).textContent ?? '',
      stage: part.querySelector('.fm-status')?.textContent ?? '',
    }))
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

  // The topbar's avatar of the player named `displayName`, or null.
  avatar(displayName: string): HTMLElement | null {
    return screen.queryByRole('img', { name: displayName })
  }

  // The button that shows and hides the sidebar's labels.
  get sidebarLabelsButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Sidebar labels' })
  }
}
