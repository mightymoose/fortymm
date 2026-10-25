import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ScenarioId } from '../../pages/adopt/scenarios'
import { renderRoute } from '../renderRoute'

export type AdoptPath = '/adopt1' | '/adopt2'

export type AnswerLabel = 'Yes' | 'No, it is someone else' | 'Not mine'

// Page object for adoption mockups 1 and 2. Each asks "Is <name> you?" on a
// card: with buttons, or with radios and "Save answer". Adopt3Page covers
// option 3.
export class AdoptPage {
  static async render(path: AdoptPath, state: ScenarioId): Promise<AdoptPage> {
    await renderRoute(`${path}?state=${state}`)
    return new AdoptPage(path)
  }

  private readonly path: AdoptPath

  constructor(path: AdoptPath) {
    this.path = path
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  // The open question about `name`, or null once it's answered.
  async question(name: string): Promise<HTMLElement | null> {
    return screen.queryByRole('region', { name: `Is ${name} you?` })
  }

  async yesAvailable(name: string): Promise<boolean> {
    const yes = this.control(await this.mustFind(name), 'Yes')
    return !(yes as HTMLInputElement).disabled && yes.getAttribute('aria-disabled') !== 'true'
  }

  async answer(name: string, label: AnswerLabel): Promise<void> {
    const question = await this.mustFind(name)
    await userEvent.click(this.control(question, label))
    if (this.path === '/adopt2') {
      await userEvent.click(within(question).getByRole('button', { name: 'Save answer' }))
    }
  }

  private control(question: HTMLElement, label: AnswerLabel): HTMLElement {
    const role = this.path === '/adopt2' ? 'radio' : 'button'
    return within(question).getByRole(role, { name: new RegExp(`^${label}`) })
  }

  private async mustFind(name: string): Promise<HTMLElement> {
    const question = await this.question(name)
    if (!question) throw new Error(`No open question about ${name}`)
    return question
  }
}
