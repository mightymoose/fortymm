import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page a result link opens, where the other player
// submits the result or goes back to edit the scores.
export class AcceptResultPage {
  // Renders the link's path and fragment, such as
  // `/matches/demo/scores/approvals/new#<envelope>`.
  static async render(path: string): Promise<AcceptResultPage> {
    return new AcceptResultPage(await renderRoute(path))
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  get hash(): string {
    return this.router.state.location.hash
  }

  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  get result(): HTMLElement {
    return screen.getByRole('region', { name: 'Result' })
  }

  // Each row of the game scores table, as shown: the player, each game's
  // points, then the games won.
  get gameScores(): string[][] {
    return within(this.result)
      .getAllByRole('row')
      .slice(1)
      .map((row) => [...row.children].map((cell) => cell.textContent ?? ''))
  }

  get approveForm(): HTMLElement | null {
    return screen.queryByRole('form', { name: 'Approve the result' })
  }

  async approve(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: 'Approve result' }))
  }

  // The line that says the result is approved. The toast region is a
  // status too, so it's found by its text.
  get status(): HTMLElement | null {
    return screen.queryAllByRole('status').find((status) => status.textContent?.startsWith('Approved')) ?? null
  }

  async findStatus(): Promise<HTMLElement> {
    return waitFor(() => {
      const status = this.status
      if (!status) throw new Error('no approval status')
      return status
    })
  }

  // The game columns' headers, as screen readers hear them.
  get columns(): string[] {
    return within(this.result)
      .getAllByRole('columnheader')
      .map((header) => header.querySelector('.fm-sr')?.textContent ?? header.textContent ?? '')
  }

  async editScores(): Promise<void> {
    await userEvent.click(screen.getByRole('link', { name: 'Edit scores' }))
  }

  // Waits for the scratchpad page that Edit scores opens.
  async waitForScores(path: string): Promise<void> {
    await screen.findByRole('heading', { level: 1, name: 'Game 1' })
    if (this.router.state.location.pathname !== path) throw new Error(this.router.state.location.pathname)
  }

  async findAlert(): Promise<HTMLElement> {
    return screen.findByRole('alert')
  }

  async findHeading(name: string): Promise<HTMLElement> {
    return screen.findByRole('heading', { level: 1, name })
  }

  close(): void {
    cleanup()
  }
}
