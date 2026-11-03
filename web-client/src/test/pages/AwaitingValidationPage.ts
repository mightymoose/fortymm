import { screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page a player lands on after submitting a result,
// which shows the signed result's QR code and link.
export class AwaitingValidationPage {
  // Renders the page for `matchId` directly, as a reload does.
  static async render(matchId = 'demo'): Promise<AwaitingValidationPage> {
    return new AwaitingValidationPage(await renderRoute(`/matches/${matchId}/score-validations/new`))
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  get href(): string {
    return this.router.state.location.href
  }

  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  // The submitted games and who wins.
  get result(): HTMLElement {
    return screen.getByRole('region', { name: 'Result' })
  }

  get qrCode(): HTMLElement {
    return screen.getByRole('img', { name: 'QR code of the signed result' })
  }

  // The link that carries the signed result, once it is signed.
  async findLink(): Promise<HTMLAnchorElement> {
    return (await screen.findByRole('link', { name: /\/r#/ })) as HTMLAnchorElement
  }

  async findAlert(): Promise<HTMLElement> {
    return screen.findByRole('alert')
  }

  async waitForPath(path: string): Promise<void> {
    await waitFor(() => expect(this.router.state.location.pathname).toBe(path))
  }
}
