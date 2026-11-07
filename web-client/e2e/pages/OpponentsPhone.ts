import type { Browser, BrowserContext } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'
import { expect } from '../fixtures.ts'
import { HomePage } from './HomePage.ts'

type SessionResponse = components['schemas']['SessionResponse']
type SessionPlayer = SessionResponse['data']['account']['player']

const PHONE = { width: 390, height: 844 }

// A guest's phone, the opponent of the administrator's. A spec keeps one
// for the whole file, because the suite stays under the guest account
// limit. A guest holds no `matches.score`, so the administrator's session
// uploads what this phone approved: the signatures, not the session, are
// the authority.
export class OpponentsPhone {
  readonly context: BrowserContext
  readonly player: SessionPlayer

  private constructor(context: BrowserContext, player: SessionPlayer) {
    this.context = context
    this.player = player
  }

  static async open(browser: Browser, baseURL: string | undefined): Promise<OpponentsPhone> {
    const context = await browser.newContext({ baseURL, viewport: PHONE, storageState: { cookies: [], origins: [] } })
    const session = await context.request.post('/api/v1/session', { headers: { 'Content-Type': 'application/json' } })
    return new OpponentsPhone(context, ((await session.json()) as SessionResponse).data.account.player)
  }

  // Approves the result `link` holds, which works with no request of its
  // own, and gives the envelope with both signatures.
  async approve(link: string): Promise<string> {
    const page = await this.context.newPage()
    try {
      const keyRegistered = new HomePage(page).keyRegistered()
      await page.goto(link)
      await keyRegistered
      const before = new URL(page.url()).hash
      await page.getByRole('button', { name: 'Approve result' }).click()
      await expect.poll(() => new URL(page.url()).hash).not.toBe(before)
      return new URL(page.url()).hash.slice(1)
    } finally {
      await page.close()
    }
  }

  close(): Promise<void> {
    return this.context.close()
  }
}
