import type { Locator, Page } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'

type MatchRequest = components['schemas']['MatchRequest']

// Page object for an API match's scoring page, on one phone.
export class ScoringPage {
  readonly page: Page
  readonly heading: Locator
  readonly inputs: Locator
  readonly strip: Locator
  // The strip's note on the sync, such as `Offline. Saved on this device.`
  readonly stripNote: Locator

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1 })
    this.inputs = page.getByRole('textbox')
    this.strip = page.getByRole('navigation', { name: 'Games' })
    this.stripNote = this.strip.getByRole('status')
  }

  slot(game: number): Locator {
    return this.strip.locator('.score-slot', { hasText: `Game ${game}` })
  }

  // A game's score as its cell shows it, left side first, such as `11–5`.
  points(game: number): Locator {
    return this.slot(game).locator('.score-slot__pts')
  }

  // What a screen reader hears about a game's sync, such as `Synced`.
  slotSync(game: number): Locator {
    return this.slot(game).locator('.score-slot__sync')
  }

  // The URL's fragment, which holds the pad's scores, without its `#`.
  get fragment(): string {
    return new URL(this.page.url()).hash.slice(1)
  }

  // Opens game 1 of `match` from a fragment made with the app's own
  // encoder, which the dev server serves.
  async open(match: MatchRequest): Promise<void> {
    // The import needs a page of the dev server's. This one starts no session.
    await this.page.goto('/design-system')
    const hash = await this.page.evaluate(
      async ({ match, modules }) => {
        const { draftHash } = await import(modules.fragment)
        const { apiMatch } = await import(modules.matches)
        const opened = apiMatch(match.id, match.best_of, match.rated, match.players)
        return draftHash(opened, [], null, Math.floor(Date.now() / 1000))
      },
      { match, modules: { fragment: '/src/scoring/fragment.ts', matches: '/src/scoring/matches.ts' } },
    )
    await this.page.goto(`/matches/${match.id}/scores/game/1/edit#${hash}`)
    // The dev server serves the page's modules one by one, so the page is
    // ready only once the pad shows.
    await this.inputs.nth(1).waitFor()
  }

  // Left side first.
  async save(game: number, [left, right]: [number, number]): Promise<void> {
    await this.inputs.nth(0).fill(String(left))
    await this.inputs.nth(1).fill(String(right))
    await this.page.getByRole('button', { name: `Save game ${game}` }).click()
  }

  // Submits the open game's score, left side first, and gives the approval
  // link.
  async submit([left, right]: [number, number]): Promise<string> {
    await this.inputs.nth(0).fill(String(left))
    await this.inputs.nth(1).fill(String(right))
    await this.page.getByRole('button', { name: 'Submit result' }).click()
    const link = this.page.getByRole('link', { name: /\/scores\/approvals\/new#/ })
    return (await link.getAttribute('href'))!
  }

  // Starts noting whether any cell shows green `Synced`, however briefly.
  // `everSynced()` reads it.
  async watchSyncedMarks(): Promise<void> {
    await this.page.evaluate(`(() => {
      globalThis.everSynced = false
      new MutationObserver(() => {
        if (document.querySelector('.score-slot--synced')) globalThis.everSynced = true
      }).observe(document.body, { subtree: true, childList: true, attributes: true })
    })()`)
  }

  everSynced(): Promise<boolean> {
    return this.page.evaluate('globalThis.everSynced')
  }
}
