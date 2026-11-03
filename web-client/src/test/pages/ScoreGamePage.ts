import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { signWithDeviceKey } from '../../signing/deviceKey'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for the page that edits one game of a match's scores. The
// mock session's player is `excited egret 387`, who plays the `demo` match
// against `brave badger 214`. The scores live in the URL's fragment, so
// `href` includes it, and rendering an `href` again is a reload.
export class ScoreGamePage {
  static async render(path = '/matches/demo/scores/game/1/edit'): Promise<ScoreGamePage> {
    const page = new ScoreGamePage(await renderRoute(path))
    await page.settle()
    return page
  }

  readonly router: AppRouter

  constructor(router: AppRouter) {
    this.router = router
  }

  // Closes the page, as a reload does before the page renders again.
  close(): void {
    cleanup()
  }

  // The path, query and fragment.
  get href(): string {
    const { href, hash } = this.router.state.location
    return hash && !href.includes('#') ? `${href}#${hash}` : href
  }

  get pathname(): string {
    return this.router.state.location.pathname
  }

  // The fragment, without its `#`.
  get hash(): string {
    return this.router.state.location.hash
  }

  get text(): string {
    return document.body.textContent ?? ''
  }

  // "Game N", the game the pad edits.
  get heading(): HTMLElement {
    return screen.getByRole('heading', { level: 1 })
  }

  get wordmark(): HTMLElement {
    return screen.getByRole('img', { name: 'FortyMM' })
  }

  get homeLink(): HTMLElement {
    return screen.getByRole('link', { name: 'Home' })
  }

  // The games tally, left side first, such as "2–1".
  get tally(): string {
    const tally = screen.getByRole('region', { name: 'Match' }).querySelector('.score-tally')
    return tally?.textContent?.replace('Games ', '') ?? ''
  }

  // The players by name, left then right.
  get sides(): string[] {
    return [...document.querySelectorAll('.score-player__name')].map((name) => name.textContent ?? '')
  }

  // The notices above the pad, such as what the scores correct.
  get notices(): string[] {
    return [...document.querySelectorAll('.score-content > .fm-notice')].map((notice) => notice.textContent ?? '')
  }

  private get strip(): HTMLElement {
    return screen.getByRole('navigation', { name: 'Games' })
  }

  // The strip's cell for game `game`.
  private cell(game: number): HTMLElement {
    const cell = within(this.strip).getAllByRole('listitem')[game - 1]
    return cell.firstElementChild as HTMLElement
  }

  // The strip's link to game `game`, or null when the game can't open yet.
  slotLink(game: number): HTMLElement | null {
    const cell = this.cell(game)
    return cell.tagName === 'A' ? cell : null
  }

  slot(game: number): HTMLElement {
    const link = this.slotLink(game)
    if (!link) throw new Error(`game ${game} has no link`)
    return link
  }

  // The score the strip shows for game `game`, such as "11–7", or "–".
  slotScore(game: number): string {
    return this.cell(game).querySelector('.score-slot__pts')?.textContent ?? ''
  }

  // The bold points of game `game` in the strip, the winner's.
  slotWinner(game: number): string | null {
    return this.cell(game).querySelector('b')?.textContent ?? null
  }

  // The score input for `player`.
  input(player: string): HTMLInputElement {
    return screen.getByRole('textbox', { name: player }) as HTMLInputElement
  }

  // Types a score for each player, replacing what the inputs held.
  async enter(scores: Record<string, string>): Promise<void> {
    for (const [player, score] of Object.entries(scores)) {
      const input = this.input(player)
      await userEvent.clear(input)
      if (score !== '') await userEvent.type(input, score)
    }
  }

  get saveButton(): HTMLButtonElement | null {
    return screen.queryByRole('button', { name: /^Save game \d+$/ }) as HTMLButtonElement | null
  }

  async save(): Promise<void> {
    await this.pressAndWait(this.saveButton!)
  }

  // The reason or hint under the pad that its inputs point to, or null.
  get feedback(): string | null {
    const id = this.input(this.sides[0]).getAttribute('aria-describedby')
    return id ? (document.getElementById(id)?.textContent ?? null) : null
  }

  button(name: string): HTMLElement | null {
    return screen.queryByRole('button', { name })
  }

  // Presses a button that moves the page on, such as Clear game or Submit
  // result, and waits until it has.
  async click(name: string): Promise<void> {
    await this.pressAndWait(screen.getByRole('button', { name }))
  }

  // A press hashes the result it corrects, or signs, before the URL
  // changes, so it waits for the URL or for an alert that says why not.
  private async pressAndWait(button: HTMLElement): Promise<void> {
    const before = this.href
    await userEvent.click(button)
    await waitFor(() => {
      if (this.href === before && !screen.queryByRole('alert')) throw new Error('the page didn’t move on')
    })
    await this.settle()
  }

  async findAlert(): Promise<HTMLElement> {
    return screen.findByRole('alert')
  }

  // The spectator's note about who submits.
  get result(): HTMLElement {
    return screen.getByRole('region', { name: 'Result' })
  }

  // Goes to a game the way the strip's link does.
  async goToGame(game: number): Promise<void> {
    await userEvent.click(this.slot(game))
    await this.settle()
  }

  // This browser makes its signing key in the background once the session
  // answers, so a test that submits waits for it first.
  async waitForKey(): Promise<void> {
    await waitFor(async () => {
      if (!(await signWithDeviceKey())) throw new Error('no signing key yet')
    })
  }

  async waitForPath(path: string): Promise<void> {
    await waitFor(() => {
      if (this.pathname !== path) throw new Error(`at ${this.pathname}`)
    })
    await this.settle()
  }

  // Waits for the router to finish loading the page it's going to.
  async settle(): Promise<void> {
    await waitFor(() => {
      if (this.router.state.status !== 'idle') throw new Error('still loading')
    })
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setTimeout(resolve))
    }
  }
}
