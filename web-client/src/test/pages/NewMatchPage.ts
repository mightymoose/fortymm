import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page that sets up a new match. The mock session's
// player is `excited egret 387`. Lists of players are found by their
// accessible names, the recent opponents' and the search's.
export class NewMatchPage {
  static async render(options?: Parameters<typeof renderRoute>[1]): Promise<NewMatchPage> {
    return new NewMatchPage(await renderRoute('/matches/new', options))
  }

  readonly router: AppRouter
  private readonly user = userEvent.setup()

  constructor(router: AppRouter) {
    this.router = router
  }

  get pathname(): string {
    return this.router.state.location.pathname
  }

  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get card(): HTMLElement {
    return screen.getByRole('region', { name: 'Match setup' })
  }

  // The skeleton of the recent opponents, or null once they show.
  get recentSkeleton(): HTMLElement | null {
    return screen.queryByRole('status', { name: 'Loading recent opponents' })
  }

  // The names of the recent opponents, once they show.
  async findRecent(): Promise<string[]> {
    return names(await screen.findByRole('list', { name: 'Recent opponents' }))
  }

  // The names of the players the search found, once they show.
  async findResults(): Promise<string[]> {
    return names(await screen.findByRole('list', { name: 'Players found' }))
  }

  get text(): string {
    return this.card.textContent ?? ''
  }

  // Every alert's text.
  get alerts(): string[] {
    return screen.queryAllByRole('alert').map((alert) => alert.textContent ?? '')
  }

  // Waits for an alert whose text starts with `text`.
  findAlert(text: string): Promise<HTMLElement> {
    return waitFor(() => {
      const alert = screen.queryAllByRole('alert').find((each) => each.textContent?.startsWith(text))
      if (!alert) throw new Error(`no alert says ${text}`)
      return alert
    })
  }

  // Picks the player named `name` from the list on screen.
  async pick(name: string): Promise<void> {
    await this.user.click(screen.getByRole('button', { name }))
  }

  async searchAll(): Promise<void> {
    await this.user.click(screen.getByRole('button', { name: 'Search all players' }))
  }

  get searchBox(): HTMLElement {
    return screen.getByRole('searchbox', { name: 'Search players by name' })
  }

  async search(text: string): Promise<void> {
    await this.user.type(this.searchBox, text)
  }

  async backToRecent(): Promise<void> {
    await this.user.click(screen.getByRole('button', { name: 'Back to recent opponents' }))
  }

  // The picked opponent's name, or null with none picked.
  get picked(): string | null {
    const change = screen.queryByRole('button', { name: 'Change' })
    return change?.parentElement?.querySelector('.new-match__name')?.textContent ?? null
  }

  get changeButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Change' })
  }

  get searchAllButton(): HTMLElement {
    return screen.getByRole('button', { name: 'Search all players' })
  }

  async change(): Promise<void> {
    await this.user.click(this.changeButton)
  }

  // A match length's radio, such as "3 Short".
  lengthOption(name: string): HTMLElement {
    return within(screen.getByRole('radiogroup', { name: 'Match length' })).getByRole('radio', { name })
  }

  // The match length on, such as "5 Std".
  get length(): string {
    return screen.getByRole('radio', { checked: true }).textContent ?? ''
  }

  get lengthHelp(): string {
    return screen.getByRole('radiogroup', { name: 'Match length' }).nextElementSibling?.textContent ?? ''
  }

  async pressKey(key: string): Promise<void> {
    await this.user.keyboard(key)
  }

  get ratedSwitch(): HTMLElement {
    return screen.getByRole('switch', { name: 'Rated match' })
  }

  async toggleRated(): Promise<void> {
    await this.user.click(this.ratedSwitch)
  }

  // The summary's headline and the line under it.
  get summary(): string[] {
    const headline = this.card.querySelector('.new-match__headline')
    return [headline?.textContent ?? '', headline?.nextElementSibling?.textContent ?? '']
  }

  get startButton(): HTMLElement {
    return screen.getByRole('button', { name: /^(Start match|Starting…)$/ })
  }

  async start(): Promise<void> {
    await this.user.click(this.startButton)
  }

  get cancelLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Cancel' })
  }
}

function names(list: HTMLElement): string[] {
  return within(list)
    .getAllByRole('button')
    .map((button) => button.querySelector('.new-match__name')?.textContent ?? '')
}
