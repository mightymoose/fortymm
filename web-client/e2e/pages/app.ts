import {
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from '@playwright/test'

// Once every page of the app is closed, the browser hands over to the new
// version it kept. It does so a moment after the last page goes; a person
// opening the app again comes later than that, so wait for it before the
// next opening. Asked of the service worker's registration, since no page of
// the app is open to ask.
export async function waitUntilNewVersionTakesOver(context: BrowserContext) {
  await expect
    .poll(async () => {
      for (const worker of context.serviceWorkers()) {
        const tookOver = await worker
          .evaluate(() => {
            const { registration } = self as unknown as {
              registration: ServiceWorkerRegistration
            }
            return (
              registration.waiting === null &&
              registration.active?.state === 'activated'
            )
          })
          .catch(() => false)
        if (tookOver) return true
      }
      return false
    })
    .toBe(true)
}

// The app as a person opens it: by loading an address directly (typed, a
// bookmark, a reload or the home-screen icon), so the browser answers the
// request, not the router in a page that is already open.
export class App {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  async open(path: string) {
    await this.page.goto(path)
  }

  // After a visit with a connection: wait until the browser has kept the app
  // on the device (its service worker is active and controls this page).
  // The worker takes control of the page once it has kept every file.
  async waitUntilKept() {
    await this.page.waitForFunction(
      () => navigator.serviceWorker.controller !== null,
    )
  }

  // After a new deployment was published: wait until a visit with a
  // connection has fetched and kept it, ready for the next opening (its
  // worker is installed and waiting). Chromium looks for a new sw.js a few
  // seconds after a page loads, hence the longer wait.
  async waitUntilNewVersionIsKept() {
    await expect
      .poll(
        () =>
          this.page.evaluate(async () => {
            const registration =
              await navigator.serviceWorker.getRegistration()
            return registration?.waiting?.state ?? null
          }),
        { timeout: 20_000 },
      )
      .toBe('installed')
  }
}

export class StartPage {
  readonly heading: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'Get started' })
  }

  counter(count: number): Locator {
    return this.page.getByRole('button', { name: `Count is ${count}` })
  }
}

export class HealthPage {
  readonly heading: Locator
  readonly unknown: Locator
  // The shared core's answer: the generated username of a fixed player id.
  readonly coreLoaded: Locator

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { name: 'API health' })
    this.unknown = page.getByRole('heading', {
      name: 'The API’s health is unknown',
    })
    this.coreLoaded = page.getByRole('status', {
      name: 'The shared core loaded',
    })
  }
}

export class SettingsPage {
  readonly heading: Locator
  readonly noAccount: Locator
  // The stored username: the paragraph in the region named "Username".
  readonly username: Locator

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { name: 'Account settings' })
    this.noAccount = page.getByRole('heading', { name: 'No account yet' })
    this.username = page
      .getByRole('region', { name: 'Username' })
      .getByRole('paragraph')
  }
}

export class NotFoundPage {
  readonly heading: Locator

  constructor(page: Page) {
    this.heading = page.getByRole('heading', { name: 'Page not found' })
  }
}
