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

// The notice that a new version of the app is ready
// (src/components/UpdateNotice.tsx), which the layout shows over every
// screen, and what an open page does to learn of a new version.
export class NewVersion {
  readonly notice: Locator
  readonly reload: Locator
  readonly dismiss: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.notice = page
      .getByRole('status')
      .filter({ hasText: 'A new version is ready.' })
    this.reload = this.notice.getByRole('button', { name: 'Reload' })
    this.dismiss = this.notice.getByRole('button', { name: 'Dismiss' })
  }

  // The connection drops and comes back: the open page asks the browser to
  // look for a new deployment, as it does whenever its connection returns
  // (src/new-version.ts).
  async connectionComesBack() {
    const context = this.page.context()
    await context.setOffline(true)
    await context.setOffline(false)
  }

  // Asks the browser to look for a new deployment now, and waits until it
  // has looked.
  async lookNow() {
    await this.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      await registration?.update()
    })
  }

  // Where the new deployment's worker is: 'installing' (downloading its
  // build), 'installed' (every file kept, waiting), or null (none).
  async newWorker(): Promise<string | null> {
    return this.page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration()
      const worker = registration?.installing ?? registration?.waiting
      return worker?.state ?? null
    })
  }
}

// The layout around every screen (src/components/AppLayout.tsx): the top bar
// with the FortyMM brand and, at non-phone widths, the sidebar's toggle; and
// at non-phone widths, the sidebar with its links. No goto(): every screen's
// page has it.
export class AppLayout {
  readonly banner: Locator
  readonly brand: Locator
  readonly navigation: Locator
  readonly sidebarToggle: Locator

  constructor(page: Page) {
    this.banner = page.getByRole('banner')
    this.brand = this.banner.getByRole('link', { name: 'FortyMM' })
    this.navigation = page.getByRole('navigation', { name: 'Main' })
    this.sidebarToggle = this.banner.getByRole('button', { name: 'Sidebar' })
  }

  // A link in the sidebar, by its name ("Health").
  link(name: string): Locator {
    return this.navigation.getByRole('link', { name })
  }

  // This device's user's mark in the top bar: a link named with the
  // username, showing the initials and, at non-phone widths, the username.
  userMark(username: string): Locator {
    return this.banner.getByRole('link', { name: username, exact: true })
  }

  // The bottom bar's navigation (phones only).
  get bottomBar(): Locator {
    return this.banner.page().getByRole('navigation', { name: 'Bottom bar' })
  }

  // The bottom bar's New match (phones only).
  get bottomBarNewMatch(): Locator {
    return this.bottomBar.getByRole('link', { name: 'New match' })
  }

  // The username written out in the user's mark.
  userMarkName(username: string): Locator {
    return this.userMark(username).getByText(username, { exact: true })
  }
}

// Each screen's page object below opens its page with goto(): by loading its
// address directly, as a person does by typing it, with a bookmark, a reload
// or the home-screen icon, so the browser answers the request, not the router
// in a page that is already open. goto() only navigates; a test waits for what
// it expects to see.

// The dashboard, at /: its heading and, at non-phone widths, the New match
// button beside it.
export class DashboardPage {
  readonly heading: Locator
  // The dashboard's own New match, in main (the bottom bar has its own).
  readonly newMatch: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    this.heading = page.getByRole('heading', { level: 1, name: 'Dashboard' })
    this.newMatch = page
      .getByRole('main')
      .getByRole('link', { name: 'New match' })
  }

  async goto() {
    await this.page.goto('/')
  }
}

// The new match screen, at /matches/new: the form for a match's format.
export class NewMatchPage {
  readonly heading: Locator
  readonly form: Locator
  readonly startMatch: Locator
  // The alert of a Start match the device refused for its storage.
  readonly notStarted: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.heading = main.getByRole('heading', { level: 1, name: 'New match' })
    this.form = main.getByRole('form', { name: 'New match' })
    this.startMatch = this.form.getByRole('button', { name: 'Start match' })
    this.notStarted = main.getByRole('alert', { name: 'Couldn’t start the match' })
  }

  // The match's length: the radio "Best of `n`" (1, 3, 5 or 7).
  bestOf(n: number) {
    return this.form.getByRole('radio', { name: `Best of ${n}` })
  }

  async goto() {
    await this.page.goto('/matches/new')
  }
}

// The address of a match's page, and of the scoring page of one of its
// games. A match's id is the core's match id in hex.
const matchPath = (matchId: string) => `/matches/${matchId}`
const scoringPath = (matchId: string, game: number) =>
  `${matchPath(matchId)}/games/${game}/scores/edit`

// The id of the match whose scoring page the page shows: where Start match
// goes, game 1's.
export async function scoredMatchId(page: Page): Promise<string> {
  await expect(page).toHaveURL(/\/matches\/[0-9a-f]{64}\/games\/\d+\/scores\/edit$/)
  return new URL(page.url()).pathname.split('/')[2]!
}

// A match's details page, at /matches/<id>: its title ("You vs
// Anonymous"), the format line, and its games' table.
export class MatchDetailsPage {
  readonly heading: Locator
  // The line with the format, "Best of 5 · Unrated · Game 1 next".
  readonly format: Locator
  readonly games: Locator
  // "No games yet.", in place of the table.
  readonly noGames: Locator
  // In place of the match, when the device won't read it.
  readonly unreadable: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.heading = main.getByRole('heading', { level: 1, name: /^You vs / })
    this.format = main.getByText(/^(Best of \d|Single game) · /)
    this.games = main.getByRole('table', { name: 'Games' })
    this.noGames = main.getByText('No games yet.')
    this.unreadable = main.getByRole('heading', { level: 1, name: 'Couldn’t load this match' })
  }

  // Game n's row: its header "Game n", the two scores, and who won it (or
  // "Not played").
  game(n: number): Locator {
    return this.games.getByRole('row', { name: new RegExp(`^Game ${n} `) })
  }

  async goto(matchId: string) {
    await this.page.goto(matchPath(matchId))
  }
}

// The scoring page of one game, at /matches/<id>/games/<n>/scores/edit.
export class ScoringPage {
  readonly heading: Locator
  readonly yours: Locator
  readonly theirs: Locator
  // The submit: "Save game & next", "Finish match"...
  readonly save: Locator
  readonly clear: Locator
  // The alert of a save or a clear refused for a browser feature missing.
  readonly unsupported: Locator
  // The score card: the fields, the one error line (a save the rules
  // refused), the actions.
  readonly form: Locator
  // The scoreline's polite read-out of what changed elsewhere ("Game 1
  // updated."), empty before the first change.
  readonly updated: Locator
  // The scoreline's tint on a game that changed elsewhere: decorative
  // (aria-hidden), so found by its class. It is removed once it has faded.
  readonly tint: Locator
  // Under the heading: the notice that this empty game's match was finished
  // elsewhere (its title), and its link to the match's page.
  readonly finished: Locator
  readonly goToMatch: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.heading = main.getByRole('heading', {
      level: 1,
      name: /^(Enter|Edit) game \d+ score\.$/,
    })
    this.yours = main.getByRole('textbox', { name: 'Your score' })
    this.theirs = main.getByRole('textbox', { name: 'Opponent’s score' })
    this.save = main.getByRole('button', { name: /^(Save|Finish)/ })
    this.clear = main.getByRole('button', { name: 'Clear' })
    this.unsupported = main.getByRole('alert', { name: 'Your browser doesn’t support saving matches' })
    this.form = main.getByRole('form', { name: /^Game \d+ score$/ })
    const scoreline = main.getByRole('navigation', { name: 'Scoreline' })
    this.updated = scoreline.getByRole('status')
    this.tint = scoreline.locator('.scoreline__mark')
    this.finished = main.getByText('This match was finished since you opened this page.')
    this.goToMatch = main.getByRole('link', { name: 'Go to the match' })
  }

  // Types a score, yours first, ready to save.
  async enter([yours, theirs]: [number, number]) {
    await this.yours.fill(String(yours))
    await this.theirs.fill(String(theirs))
  }

  async goto(matchId: string, game: number) {
    await this.page.goto(scoringPath(matchId, game))
  }
}

// The matches list, at /matches: its heading, its table of matches (each
// row a card on phones), and at non-phone widths New match beside the
// heading.
export class MatchesPage {
  readonly heading: Locator
  readonly table: Locator
  // The table's matches, the header row left out.
  readonly rows: Locator
  // The table's header row: its column names.
  readonly columnHeaders: Locator
  // The list's own New match, in main (the bottom bar has its own).
  readonly newMatch: Locator
  // In place of the list, when the device won't read it.
  readonly unreadable: Locator
  // The empty state: no matches on this device.
  readonly empty: Locator
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.heading = main.getByRole('heading', { level: 1, name: 'Matches' })
    this.table = main.getByRole('table', { name: 'Matches' })
    this.rows = this.table.locator('tbody tr')
    this.columnHeaders = this.table.getByRole('columnheader')
    this.newMatch = main.getByRole('link', { name: 'New match' })
    this.unreadable = main.getByRole('alert', { name: 'Couldn’t load your matches' })
    this.empty = main.getByText('No matches yet.')
  }

  async goto() {
    await this.page.goto('/matches')
  }
}

// The design system page's tabs, each a page of its own: its address and
// its board's title. Each tab's path is written only here.
const designSystemTabs = {
  colour: { path: '/design-system/colour', title: 'Colour' },
  type: { path: '/design-system/type', title: 'Type' },
  foundations: { path: '/design-system/foundations', title: 'Foundations' },
  controls: { path: '/design-system/controls', title: 'Controls' },
  feedback: { path: '/design-system/feedback', title: 'Feedback' },
}

export type DesignSystemTab = keyof typeof designSystemTabs

// Where each design system component is checked against the design system's
// reference sheet (references/design-system/): its header (the wordmark and
// the page's title), its tabs, a page per board of the sheet, and the
// current tab's board. It is all in the layout's main landmark; the
// layout's top bar is the banner.
export class DesignSystemPage {
  readonly wordmark: Locator
  readonly heading: Locator
  readonly tabs: Locator
  private readonly page: Page
  // The tab goto() opened (/design-system opens Colour).
  private shown: DesignSystemTab = 'colour'

  constructor(page: Page) {
    this.page = page
    const main = page.getByRole('main')
    this.wordmark = main.getByRole('img', { name: 'FortyMM' })
    this.heading = main.getByRole('heading', {
      level: 1,
      name: 'Design system',
    })
    this.tabs = main.getByRole('navigation', { name: 'Design system' })
  }

  // Opens a tab's page, or /design-system itself, which shows Colour.
  async goto(tab?: DesignSystemTab) {
    this.shown = tab ?? 'colour'
    await this.page.goto(tab ? designSystemTabs[tab].path : '/design-system')
  }

  // A tab's board, by its tab ('controls'): the region named by its title.
  board(tab: DesignSystemTab): Locator {
    return this.page.getByRole('region', {
      name: designSystemTabs[tab].title,
      exact: true,
    })
  }

  // Waits until the page shows the tab it opened and every font it uses
  // has loaded, so a screenshot is never taken in a fallback font.
  async waitUntilDrawn() {
    await expect(this.board(this.shown)).toBeVisible()
    await this.page.evaluate(() => document.fonts.ready.then(() => undefined))
  }

  // A target of the reference sheet's boards, by the data-testid the board
  // gives it (state-primary-button--hover, color-ink-950, section-buttons),
  // or the tabs themselves (design-system-tabs).
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
