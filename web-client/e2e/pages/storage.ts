import type { Page } from '@playwright/test'

// The storage harness page (../harness/storage.html), in the "harness"
// deployment: each method calls the same-named function the page puts on
// window.storageHarness, in the page.
export type User = {
  playerId: string
  accountId: string
  username: string
  publicKey: string
  unconfirmed: boolean
}
type Result = { ok: true } | { ok: false; reason: string }
type Loaded = { ok: true; user: User | null } | { ok: false; reason: string }
type Expected = Omit<User, 'unconfirmed'>

type Harness = {
  storeHello(times?: number): Promise<{ results: Result[]; expected: Expected }>
  loadUser(playerId: string): Promise<Loaded>
  kept(): Promise<{ records: number; users: number }>
}

export const storageHarnessPath = '/storage.html'

export class StorageHarness {
  private readonly page: Page

  constructor(page: Page) {
    this.page = page
  }

  // Loads the page directly, as a tab does, and waits for its script.
  async open() {
    await this.page.goto(storageHarnessPath)
    await this.page.waitForFunction(() => 'storageHarness' in window)
  }

  storeHello(times = 1) {
    return this.page.evaluate(
      (times) =>
        (window as unknown as { storageHarness: Harness }).storageHarness.storeHello(
          times,
        ),
      times,
    )
  }

  loadUser(playerId: string) {
    return this.page.evaluate(
      (playerId) =>
        (window as unknown as { storageHarness: Harness }).storageHarness.loadUser(
          playerId,
        ),
      playerId,
    )
  }

  kept() {
    return this.page.evaluate(() =>
      (window as unknown as { storageHarness: Harness }).storageHarness.kept(),
    )
  }
}
