import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

export type AdoptionChoice = 'This is me' | 'I manage this player' | 'Remove from my account'

// Page object for "Is this you?" on Home: a reminder of the players still to
// review, and a dialog that reviews one player at a time. Mock the account
// with mockVerifiedAccount() from ../server first.
export class AdoptionPage {
  // `path` is `/?signed_in=1` right after a sign-in, and `/` on a later visit.
  static async render(path: '/' | '/?signed_in=1' = '/?signed_in=1'): Promise<AdoptionPage> {
    const router = await renderRoute(path)
    const page = new AdoptionPage(router)
    await page.settle()
    return page
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  // The open dialog, or null while it's closed.
  get dialog(): HTMLElement | null {
    return screen.queryByRole('dialog')
  }

  // The dialog's question, such as "Who is excited egret 387?".
  get dialogTitle(): string | null {
    const dialog = this.dialog
    return dialog && within(dialog).getByRole('heading', { level: 2 }).textContent
  }

  get dialogText(): string {
    return this.dialog?.textContent ?? ''
  }

  // The reminder's title, such as "2 players to review", or null.
  get reminderTitle(): string | null {
    return document.querySelector('.fm-alert__title')?.textContent ?? null
  }

  get reviewButton(): HTMLElement | null {
    return screen.queryByRole('button', { name: /^Review players?$/ })
  }

  get continueButton(): HTMLElement {
    return within(this.dialog!).getByRole('button', { name: 'Continue' })
  }

  choice(label: AdoptionChoice): HTMLInputElement {
    return within(this.dialog!).getByRole('radio', { name: new RegExp(`^${label}`) })
  }

  // The text inside the choice, under its label.
  description(label: AdoptionChoice): string {
    return this.choice(label).closest('label')?.querySelector('.fm-help')?.textContent ?? ''
  }

  // The toasts on screen, by their text.
  get toasts(): string[] {
    return [...document.querySelectorAll('.fm-toast__msg')].map((toast) => toast.textContent ?? '')
  }

  // Picks the choice, then Continue, and waits for the answer.
  async pick(label: AdoptionChoice): Promise<void> {
    await userEvent.click(this.choice(label))
    await userEvent.click(this.continueButton)
    await this.settle()
  }

  async skip(): Promise<void> {
    await userEvent.click(within(this.dialog!).getByRole('button', { name: 'Skip this player' }))
  }

  async reviewLater(): Promise<void> {
    await userEvent.click(within(this.dialog!).getByRole('button', { name: 'Review later' }))
    await this.settle()
  }

  async review(): Promise<void> {
    await userEvent.click(this.reviewButton!)
  }

  // Lets the requests and the focus moves that wait a tick finish.
  async settle(): Promise<void> {
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setTimeout(resolve))
    }
  }
}
