import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { expect } from 'vitest'
import userEvent from '@testing-library/user-event'
import type { GamePoints } from '../../scoring/board'
import { serverKey, setDemoNetwork, type Network } from '../../scoring/demoServer'
import { readBoard } from '../../scoring/scratchpad'
import { renderRoute, type AppRouter } from '../renderRoute'

// Page object for a match's scratchpad, the page that edits one game's
// score. The mock session's player is `excited egret 387`, who plays the
// `demo` match against `brave badger 214`.
export class ScoreGamePage {
  static async render(path = '/matches/demo/scores/game/1/edit'): Promise<ScoreGamePage> {
    const page = new ScoreGamePage(await renderRoute(path))
    await page.settle()
    return page
  }

  // Switches the demo server's network, as a connection that drops or
  // comes back, and waits for the sync it starts.
  async switchNetwork(network: Network): Promise<void> {
    act(() => setDemoNetwork(network))
    await this.settle()
  }

  async reconnect(): Promise<void> {
    await this.switchNetwork('normal')
  }

  readonly router: AppRouter

  // Closes the page, as a reload does before the page renders again.
  close(): void {
    cleanup()
  }

  constructor(router: AppRouter) {
    this.router = router
  }

  get href(): string {
    return this.router.state.location.href
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

  // The game strip's link to game `game`.
  slot(game: number): HTMLElement {
    return within(screen.getByRole('navigation', { name: 'Games' })).getByRole('link', {
      name: new RegExp(`^Game ${game} `),
    })
  }

  // The score the strip shows for game `game`, such as "11–7", or "–".
  slotScore(game: number): string {
    return this.slot(game).querySelector('.score-slot__pts')?.textContent ?? ''
  }

  // Where game `game`'s last change stands in the strip: "Syncing", "Not
  // synced", "Synced", or null once it settles.
  slotSync(game: number): string | null {
    return this.slot(game).querySelector('.score-slot__sync')?.textContent?.trim() ?? null
  }

  // Whether game `game` shows its change on its way to the server (the dot)
  // and its sync stuck (the dashed edge). Each is on its own.
  slotSyncMarks(game: number): { sending: boolean; stuck: boolean } {
    const slot = this.slot(game)
    return {
      sending: slot.classList.contains('score-slot--sending'),
      stuck: slot.classList.contains('score-slot--stuck'),
    }
  }

  // Game `game`'s points on the demo server, or null when it has none.
  serverScore(game: number): GamePoints | null {
    return readBoard(serverKey(this.matchId)).games[game]?.points ?? null
  }

  get matchId(): string {
    return this.href.split('/')[2]
  }

  // The bold points of game `game` in the strip, the winner's.
  slotWinner(game: number): string | null {
    return this.slot(game).querySelector('b')?.textContent ?? null
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
    await userEvent.click(this.saveButton!)
    await this.settle()
  }

  // The reason or hint under the pad that its inputs point to, or null.
  get feedback(): string | null {
    const id = this.input(this.sides[0]).getAttribute('aria-describedby')
    return id ? (document.getElementById(id)?.textContent ?? null) : null
  }

  button(name: string): HTMLElement | null {
    return screen.queryByRole('button', { name })
  }

  async click(name: string): Promise<void> {
    await userEvent.click(screen.getByRole('button', { name }))
    await this.settle()
  }

  // The testing panel's choice of network.
  network(label: string): HTMLElement {
    return screen.getByRole('radio', { name: label })
  }

  // The match's result section: a spectator's note or the submitted result.
  get result(): HTMLElement {
    return screen.getByRole('region', { name: 'Result' })
  }

  // Goes to a game the way the strip's link does.
  async goToGame(game: number): Promise<void> {
    await userEvent.click(this.slot(game))
    await this.settle()
  }

  // Waits until the page has nothing loading or saving, as the demo server
  // answers after a delay.
  async settle(): Promise<void> {
    await waitFor(() => expect(document.querySelector('[aria-busy=true]')).toBeNull(), { timeout: 3000 })
    for (let tick = 0; tick < 5; tick++) {
      await new Promise((resolve) => setTimeout(resolve))
    }
  }
}
