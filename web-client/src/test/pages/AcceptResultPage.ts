import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page a result link opens, where the other player
// approves the result or goes back to edit the scores, and anyone else
// sees it read only.
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

  get approveButton(): HTMLElement | null {
    return screen.queryByRole('button', { name: 'Approve result' })
  }

  async approve(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: 'Approve result' }))
  }

  // Taps Approve twice before React renders again, as a quick double tap
  // can, then waits for the approval.
  async approveTwiceAtOnce(): Promise<void> {
    const button = screen.getByRole('button', { name: 'Approve result' })
    fireEvent.click(button)
    fireEvent.click(button)
    await this.findStatus()
  }

  get editScoresLink(): HTMLElement | null {
    return screen.queryByRole('link', { name: 'Edit scores' })
  }

  get signInLink(): HTMLElement | null {
    return screen.queryByRole('link', { name: 'Sign in' })
  }

  // A line that tells the viewer where the result stands, such as whom it
  // waits for, found by its text.
  notice(text: string): HTMLElement | null {
    return screen.queryAllByRole('status').find((status) => status.textContent === text) ?? null
  }

  // This browser makes its signing key in the background once the session
  // answers, so a test that approves waits for it first.
  async waitForKey(): Promise<void> {
    await waitFor(async () => {
      if (!(await signWithDeviceKey())) throw new Error('no signing key yet')
    })
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

  // Whether FortyMM's check of the approved result is still loading.
  get checking(): boolean {
    return screen.queryByText('Checking with FortyMM') !== null
  }

  // The line that says FortyMM took the approved result.
  async findChecked(): Promise<HTMLElement> {
    return screen.findByText('Approved. FortyMM has the result.')
  }

  // The alert that says FortyMM refused the approved result.
  async findRefusal(): Promise<HTMLElement> {
    const title = await screen.findByText('FortyMM didn’t accept this result')
    return title.closest<HTMLElement>('[role=alert]')!
  }

  // Clicks Try again on the check's error, which the alert shows when
  // FortyMM couldn't be reached.
  async tryAgain(alert: HTMLElement): Promise<void> {
    await userEvent.click(within(alert).getByRole('button', { name: 'Try again' }))
  }

  async editScores(): Promise<void> {
    await userEvent.click(screen.getByRole('link', { name: 'Edit scores' }))
  }

  // Waits for the scores page that Edit scores opens.
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
