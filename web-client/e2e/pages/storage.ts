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

type KeptRecord = { hex: string; byteLength: number; bufferByteLength: number }
type Counts = { records: number; users: number }

type Harness = {
  storeHello(times?: number): Promise<{ results: Result[]; expected: Expected }>
  storeWhileCallerChangesIt(): Promise<{ result: Result; signed: string; kept: KeptRecord }>
  storeAsSlice(): Promise<{
    result: Result
    signed: string
    length: number
    kept: KeptRecord
  }>
  storeTwoSignaturesOfOneBody(): Promise<{
    results: Result[]
    first: string
    second: string
    kept: KeptRecord
    counts: Counts
  }>
  expectedUser(): Promise<Expected>
  loadUser(playerId: string): Promise<Loaded>
  kept(): Promise<Counts>
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

  // What the core gives for this device's key; makes the key if none is
  // kept.
  expectedUser() {
    return this.page.evaluate(() =>
      (window as unknown as { storageHarness: Harness }).storageHarness.expectedUser(),
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
    return this.call('kept')
  }

  storeWhileCallerChangesIt() {
    return this.call('storeWhileCallerChangesIt')
  }

  storeAsSlice() {
    return this.call('storeAsSlice')
  }

  storeTwoSignaturesOfOneBody() {
    return this.call('storeTwoSignaturesOfOneBody')
  }

  private call<
    Name extends
      | 'kept'
      | 'storeWhileCallerChangesIt'
      | 'storeAsSlice'
      | 'storeTwoSignaturesOfOneBody',
  >(name: Name): ReturnType<Harness[Name]> {
    return this.page.evaluate(
      (name) =>
        (
          window as unknown as {
            storageHarness: Record<string, () => Promise<unknown>>
          }
        ).storageHarness[name](),
      name,
    ) as ReturnType<Harness[Name]>
  }
}
