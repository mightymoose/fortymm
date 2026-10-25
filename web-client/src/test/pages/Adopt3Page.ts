import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ScenarioId } from '../../pages/adopt/scenarios'
import { renderRoute } from '../renderRoute'

export type Adopt3Action = 'This is me' | 'I manage this player' | 'Remove from my account'

// Page object for adoption mockup 3: a reminder on Home and a dialog that
// reviews one player at a time.
export class Adopt3Page {
  static async render(state: ScenarioId): Promise<Adopt3Page> {
    await renderRoute(`/adopt3?state=${state}`)
    return new Adopt3Page()
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

  // The Home reminder's title, such as "2 players to review", or null.
  get reminderTitle(): string | null {
    return document.querySelector('.fm-alert__title')?.textContent ?? null
  }

  get reviewButton(): HTMLElement | null {
    return screen.queryByRole('button', { name: /^Review players?$/ })
  }

  get continueButton(): HTMLElement {
    return within(this.dialog!).getByRole('button', { name: 'Continue' })
  }

  choice(label: Adopt3Action): HTMLInputElement {
    return within(this.dialog!).getByRole('radio', { name: new RegExp(`^${label}`) })
  }

  available(label: Adopt3Action): boolean {
    return !this.choice(label).disabled
  }

  // The text inside the choice, under its label.
  description(label: Adopt3Action): string {
    return this.choice(label).closest('label')?.querySelector('.fm-help')?.textContent ?? ''
  }

  // Picks the choice, then Continue.
  async pick(label: Adopt3Action): Promise<void> {
    await userEvent.click(this.choice(label))
    await userEvent.click(this.continueButton)
  }

  async skip(): Promise<void> {
    await userEvent.click(within(this.dialog!).getByRole('button', { name: 'Skip this player' }))
  }

  async reviewLater(): Promise<void> {
    await userEvent.click(within(this.dialog!).getByRole('button', { name: 'Review later' }))
  }

  async review(): Promise<void> {
    await userEvent.click(this.reviewButton!)
  }

  // Undo in the dialog's confirmation while it's open, else in the toast.
  async undo(): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  }

  // Lets the focus moves that wait a tick run.
  async settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve))
  }
}
