import { randomUUID } from 'node:crypto'
import type { Locator, Page } from '@playwright/test'
import type { components } from '../../src/api/schema.d.ts'

type SessionAccount = components['schemas']['SessionAccount']

// A public page, so landing on it starts no session of its own.
const PUBLIC_PAGE = '/design-system'

// Someone the mock provider signs in, with a verified email.
export type Person = { sub: string; email: string }

// A new person on each run, because the dev database keeps its accounts and
// identities.
export function newPerson(name: string): Person {
  const id = randomUUID()
  return { sub: `e2e|${name}-${id}`, email: `${name}-${id}@example.com` }
}

// Page object for sign-in through the mock OpenID Connect provider's sign-in
// page (the `oidc` Compose service, which the dev server proxies at /oidc).
export class SignInPage {
  readonly page: Page
  readonly subject: Locator
  readonly claims: Locator
  readonly submit: Locator

  constructor(page: Page) {
    this.page = page
    // The mock's fields sit in empty labels, so they have no accessible name.
    this.subject = page.getByPlaceholder('Enter any user/subject')
    this.claims = page.getByPlaceholder(/Optional claims JSON/)
    this.submit = page.getByRole('button', { name: 'Sign-in' })
  }

  // Signs in as `person`, and returns the URL the callback sent the browser
  // back to. `returnTo: '/'` lands on Home, which resumes the session.
  async signIn(
    person: Person,
    { returnTo = PUBLIC_PAGE }: { returnTo?: '/' | typeof PUBLIC_PAGE } = {},
  ): Promise<URL> {
    await this.page.goto(`/api/v1/auth/login?return_to=${returnTo}`)
    await this.completeSignIn(person)
    await this.page.waitForURL((url) => url.pathname === returnTo)
    return new URL(this.page.url())
  }

  // Fills the mock provider's sign-in page as `person` and sends it. The
  // browser must already be on that page, e.g. after a Sign in link.
  async completeSignIn(person: Person): Promise<void> {
    await this.subject.fill(person.sub)
    await this.claims.fill(JSON.stringify({ email: person.email, email_verified: true }))
    await this.submit.click()
  }

  // The account of the browser's session, from POST /v1/session with the
  // browser's cookies. A browser with no session gets a guest account.
  async account(): Promise<SessionAccount> {
    const response = await this.page.request.post('/api/v1/session', {
      headers: { 'Content-Type': 'application/json' },
    })
    if (!response.ok()) throw new Error(`POST /api/v1/session answered ${response.status()}`)
    const body: components['schemas']['SessionResponse'] = await response.json()
    return body.data.account
  }

  // The account's players, from GET /v1/account/players with the browser's
  // cookies.
  async players(): Promise<components['schemas']['AccountPlayer'][]> {
    const response = await this.page.request.get('/api/v1/account/players')
    if (!response.ok()) throw new Error(`GET /api/v1/account/players answered ${response.status()}`)
    const body: components['schemas']['AccountPlayersResponse'] = await response.json()
    return body.data
  }

  // Drops the session cookie, as a new browser on the same device would.
  async forgetSession(): Promise<void> {
    await this.page.context().clearCookies()
  }
}
