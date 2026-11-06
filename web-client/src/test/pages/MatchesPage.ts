import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the Matches page and a match's page in unit tests.
export class MatchesPage {
  static async render(path = '/matches'): Promise<MatchesPage> {
    return new MatchesPage(await renderRoute(path))
  }

  readonly router: AppRouter
  readonly user = userEvent.setup()

  constructor(router: AppRouter) {
    this.router = router
  }

  get path(): string {
    return this.router.state.location.pathname
  }

  get title(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  // The list's or the match's loading state, or null once it has loaded.
  get loading(): HTMLElement | null {
    return screen.queryByText(/^Loading (matches|match)$/)
  }

  get alert(): HTMLElement | null {
    return screen.queryByRole('alert')
  }

  get table(): HTMLElement | null {
    return screen.queryByRole('table')
  }

  // The names of the matches listed, as "A vs B", in order.
  matchNames(): string[] {
    return screen
      .queryAllByRole('link', { name: / vs / })
      .map((link) => link.getAttribute('aria-label') ?? '')
  }

  matchLink(name: string): HTMLElement {
    return screen.getByRole('link', { name })
  }

  link(name: string): HTMLElement {
    return screen.getByRole('link', { name })
  }

  button(name: string): HTMLElement | null {
    return screen.queryByRole('button', { name })
  }

  // A link of the sidebar, or of the tab bar below 900px.
  navLink(name: string): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Main' })).getByRole('link', { name })
  }

  get breadcrumb(): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Breadcrumb' })).getByRole('link', { name: 'Matches' })
  }

  async chip(name: string): Promise<void> {
    await this.user.click(screen.getByRole('button', { name }))
  }

  async tryAgain(): Promise<void> {
    await this.user.click(screen.getByRole('button', { name: 'Try again' }))
  }

  // What a pointer resting on the link does, and what a finger landing on
  // it does.
  async hover(link: HTMLElement): Promise<void> {
    await this.user.hover(link)
  }

  touch(link: HTMLElement): void {
    fireEvent.touchStart(link)
  }

  text(name: string | RegExp): HTMLElement | null {
    return screen.queryByText(name)
  }

  // What the sign-off card says of each side's signature, side 0 first.
  signatures(): string[] {
    const card = screen.getByRole('complementary', { name: 'Sign-off' })
    return within(within(card).getAllByRole('list')[0])
      .getAllByRole('listitem')
      .map((item) => item.lastElementChild?.lastElementChild?.textContent ?? '')
  }

  // Each history line without its time, as "Who did what".
  history(): string[] {
    return within(screen.getByRole('region', { name: 'History' }))
      .getAllByRole('listitem')
      .map((item) => item.lastElementChild?.textContent ?? '')
  }
}
