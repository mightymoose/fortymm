import { screen, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import { readQrCode } from '../readQrCode'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page a player lands on after submitting a result,
// which shows the approval link as a QR code and as a link.
export class AwaitingValidationPage {
  // Renders the page at `path`, with its fragment, as a reload does.
  static async render(path = '/matches/demo/scores/submission'): Promise<AwaitingValidationPage> {
    return new AwaitingValidationPage(await renderRoute(path))
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  get href(): string {
    return this.router.state.location.href
  }

  get pathname(): string {
    return this.router.state.location.pathname
  }

  // The fragment, without its `#`: the signed result.
  get hash(): string {
    return this.router.state.location.hash
  }

  get backLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Back to the scores' })
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

  // What a phone camera reads from the QR code.
  get qrCodeText(): string | null {
    return readQrCode(screen.getByRole('img', { name: 'QR code of the approval link' }))
  }

  // The link that carries the signed result.
  async findLink(): Promise<HTMLAnchorElement> {
    return (await screen.findByRole('link', { name: /\/scores\/approvals\/new#/ })) as HTMLAnchorElement
  }

  async findAlert(): Promise<HTMLElement> {
    return screen.findByRole('alert')
  }

  async waitForPath(path: string): Promise<void> {
    await waitFor(() => expect(this.router.state.location.pathname).toBe(path))
  }
}
