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

// The User Timing mark the app sets once its launch at startup has settled
// (firstLaunchMark in src/first-launch.ts).
const firstLaunchMark = 'fortymm:first-launch'

// What an open page of the app does that is no one screen's: its launch at
// startup, and being kept on the device. Each screen's page object opens its
// own page, with goto().
export class App {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // Waits until the launch at this opening's startup has settled
  // (src/first-launch.ts sets the mark) and gives its result: made (stored
  // this device's hello), kept (a user was already stored), or a failure.
  async firstLaunch(): Promise<
    { ok: true; outcome: 'made' | 'kept' } | { ok: false; reason: string }
  > {
    const handle = await this.page.waitForFunction(
      (name) => performance.getEntriesByName(name)[0] ?? null,
      firstLaunchMark,
    )
    return this.page.evaluate(
      (mark) => (mark as PerformanceMark).detail,
      handle,
    )
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

// The layout around every screen (src/components/AppLayout.tsx): the top bar
// with the FortyMM brand, and, at non-phone widths, the sidebar with its
// toggle and its links. No goto(): every screen's page has it.
export class AppLayout {
  readonly banner: Locator
  readonly brand: Locator
  readonly navigation: Locator
  readonly sidebarToggle: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.banner = page.getByRole('banner')
    this.brand = this.banner.getByRole('link', { name: 'FortyMM' })
    this.navigation = page.getByRole('navigation', { name: 'Main' })
    this.sidebarToggle = this.banner.getByRole('button', { name: 'Sidebar' })
  }

  // A link in the sidebar, by its name ("Health").
  link(name: string): Locator {
    return this.navigation.getByRole('link', { name })
  }

  // Waits until every font the page uses has loaded, so a screenshot is
  // never taken in a fallback font.
  async waitForFonts() {
    await this.page.evaluate(() => document.fonts.ready.then(() => undefined))
  }
}

// Each screen's page object below opens its page with goto(): by loading its
// address directly, as a person does by typing it, with a bookmark, a reload
// or the home-screen icon, so the browser answers the request, not the router
// in a page that is already open. goto() only navigates; a test waits for what
// it expects to see.

// The start page is blank; its one element is a heading for screen readers.
export class StartPage {
  readonly heading: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1, name: 'FortyMM' })
  }

  async goto() {
    await this.page.goto('/')
  }
}

// Where each design system component is checked against the design system's
// reference sheet (references/design-system/): its header (the wordmark and
// the page's title), then a section per board, so far the controls. It is
// all in the layout's main landmark; the layout's top bar is the banner.
export class DesignSystemPage {
  readonly wordmark: Locator
  readonly heading: Locator
  readonly controls: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.wordmark = main.getByRole('img', { name: 'FortyMM' })
    this.heading = main.getByRole('heading', {
      level: 1,
      name: 'Design system',
    })
    this.controls = page.getByRole('region', { name: 'Controls' })
  }

  async goto() {
    await this.page.goto('/design-system')
  }

  // Waits until the page shows its sections and every font it uses has
  // loaded, so a screenshot is never taken in a fallback font.
  async waitUntilDrawn() {
    await expect(this.controls).toBeVisible()
    await this.page.evaluate(() => document.fonts.ready.then(() => undefined))
  }

  // A target of the reference sheet's boards, by the data-testid the board
  // gives it (state-primary-button--hover, field-anatomy, section-buttons).
  target(testId: string): Locator {
    return this.page.getByTestId(testId)
  }
}

export class HealthPage {
  readonly heading: Locator
  readonly unknown: Locator
  // The shared core's answer: the generated username of a fixed player id.
  readonly coreLoaded: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'API health' })
    this.unknown = page.getByRole('heading', {
      name: 'The API’s health is unknown',
    })
    this.coreLoaded = page.getByRole('status', {
      name: 'The shared core loaded',
    })
  }

  async goto() {
    await this.page.goto('/health')
  }
}

export class SettingsPage {
  readonly heading: Locator
  readonly noAccount: Locator
  // While the page waits for this device's account.
  readonly reading: Locator
  // The stored username: the paragraph in the region named "Username".
  readonly username: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'Account settings' })
    this.noAccount = page.getByRole('heading', { name: 'No account yet' })
    this.reading = page.getByRole('heading', {
      name: 'Reading this device’s account',
    })
    this.username = page
      .getByRole('region', { name: 'Username' })
      .getByRole('paragraph')
  }

  async goto() {
    await this.page.goto('/settings')
  }
}

// What the app shows at any path that is none of its screens.
export class NotFoundPage {
  readonly heading: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { name: 'Page not found' })
  }

  // Loads a path the app has no screen for, '/no/such/page' unless the test
  // gives one.
  async goto(path = '/no/such/page') {
    await this.page.goto(path)
  }
}
