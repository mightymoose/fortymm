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
  loadMe(): Promise<Loaded>
  storeOwnHello(): Promise<{ result: Result; expected: Expected }>
  kept(): Promise<Counts>
}

// A record for the harness to make, signed by this device's key: see
// harness/storage.ts.
export type Spec =
  | { kind: 'player' }
  | { kind: 'match'; opponent: string; bestOf: number; rated: boolean; terms?: string }
  | {
      kind: 'score'
      match: string
      slot: number
      score: [number, number] | null
      replaces: string[]
    }
  | { kind: 'again'; record: string }
export type Made = { record: string; id: string; player?: string }

// What core.matchState gives, in hex.
export type State = {
  matchId: string
  creator: string
  sides: [string[], string[]]
  terms: { bestOf: number; rated: boolean } | null
  games: ([number, number] | null)[]
  current: string[][]
}
// A row of the `matches` view.
export type View = State & { seq: number }
export type StoredMatch = {
  matchId: string
  bestOf: number
  rated: boolean
  games: ([number, number] | null)[]
}
type LoadedMatch<M> = { ok: true; match: M | null } | { ok: false; reason: string }
export type FailWrites = 'refused' | 'aborted'
export type StoreName = 'records' | 'journal' | 'matches' | 'users' | 'me'

// A draft for the harness's commit: see harness/storage.ts.
export type SignFault = 'throws' | 'truncated' | 'wrong-key'
export type Refusal = { reason: string; message: string }
export type CommitSpec =
  | { kind: 'create'; bestOf: number; rated: boolean; fault?: SignFault; swallow?: boolean }
  | { kind: 'score'; match: string; game: number; score: [number, number] | null }
  | { kind: 'refuse'; refusal: Refusal }
  | { kind: 'write-then-refuse'; write: 'append' | 'me'; refusal: Refusal }
  | { kind: 'foreign'; from: 'another-key' | 'kept' }
  | { kind: 'builder-throws' }
  | { kind: 'throws' }
export type Committed = { made: string[]; read?: string[] }
export type CommitAnswer =
  | { ok: true; value: Committed }
  | ({ ok: false } & ({ reason: string } | Refusal))
  | `threw: ${string}`
export type KeptByCore = { id: string; kind: string | null; verifies: boolean; signer: string }

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

  // This device's user, by loadMe.
  loadMe() {
    return this.call('loadMe')
  }

  // Stores a new hello as this device's own (first launch's way).
  storeOwnHello() {
    return this.call('storeOwnHello')
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

  // The journal and the match view (harness/storage.ts says what each does).

  makeRecords(specs: Spec[]): Promise<Made[]> {
    return this.invoke('makeRecords', specs)
  }

  ownPlayerId(): Promise<string> {
    return this.invoke('ownPlayerId')
  }

  append(records: string[]): Promise<Result> {
    return this.invoke('append', records)
  }

  appendEach(batches: string[][]): Promise<Result[]> {
    return this.invoke('appendEach', batches)
  }

  heldLoadMatch(matchId: string): Promise<LoadedMatch<StoredMatch & { current: string[][] }>> {
    return this.invoke('heldLoadMatch', matchId)
  }

  loadMatch(matchId: string): Promise<LoadedMatch<StoredMatch>> {
    return this.invoke('loadMatch', matchId)
  }

  loadMatches(): Promise<
    | { ok: true; matches: Omit<StoredMatch, 'games'>[] }
    | { ok: false; reason: string }
  > {
    return this.invoke('loadMatches')
  }

  // The journal's commit (src/journal.ts), running the draft a spec names
  // (harness/storage.ts says what each does).
  commit(spec: CommitSpec): Promise<CommitAnswer> {
    return this.invoke('commit', spec)
  }

  // Each spec committed at once, queued for the append lock in the order
  // given: what each answered.
  commitTogether(specs: CommitSpec[]): Promise<CommitAnswer[]> {
    return this.invoke('commitTogether', specs)
  }

  // Takes the append lock, and keeps it until releaseLock.
  holdLock(): Promise<void> {
    return this.invoke('holdLock')
  }

  releaseLock(): Promise<void> {
    return this.invoke('releaseLock')
  }

  // Resolves once this many requests for the append lock wait for it, in
  // any tab.
  waitForQueued(count: number): Promise<void> {
    return this.invoke('waitForQueued', count)
  }

  // Every record kept, as the core reads it.
  keptRecords(): Promise<KeptByCore[]> {
    return this.invoke('keptRecords')
  }

  // A hello signed by this device's key (hex), not stored.
  hello(): Promise<string> {
    return this.invoke('hello')
  }

  // The public storeRecord, for a record (hex).
  storeRecord(record: string): Promise<Result> {
    return this.invoke('storeRecord', record)
  }

  // Starts a harness call (by the name of its function on the page) without
  // waiting for it; answer(key) gives what it answered, 'pending' until it
  // has, or 'threw: …'.
  async start(key: string, name: string, ...args: unknown[]): Promise<void> {
    await this.page.evaluate(
      ([key, name, args]) => {
        const page = window as unknown as {
          storageHarness: Record<string, (...args: unknown[]) => Promise<unknown>>
          answers?: Record<string, unknown>
        }
        const answers = (page.answers ??= {})
        answers[key] = 'pending'
        void page.storageHarness[name](...args).then(
          (answer) => (answers[key] = answer),
          (error) => (answers[key] = `threw: ${String(error)}`),
        )
      },
      [key, name, args] as const,
    )
  }

  answer(key: string): Promise<unknown> {
    return this.page.evaluate(
      (key) => (window as unknown as { answers?: Record<string, unknown> }).answers?.[key],
      key,
    )
  }

  rebuildViews(): Promise<Result> {
    return this.invoke('rebuildViews')
  }

  // What the core's matchState gives for each match the kept records are
  // about, from the records alone (null: its match record isn't kept).
  expectedViews(): Promise<Record<string, State | null>> {
    return this.invoke('expectedViews')
  }

  readStore(name: string): Promise<[unknown, unknown][]> {
    return this.invoke('readStore', name)
  }

  // The `matches` view as a map from match id to row.
  async views(): Promise<Record<string, View>> {
    return Object.fromEntries((await this.readStore('matches')) as [string, View][])
  }

  // How many entries each store holds.
  async counts(): Promise<Record<StoreName, number>> {
    const names: StoreName[] = ['records', 'journal', 'matches', 'users', 'me']
    const counts = await Promise.all(names.map(async (name) => (await this.readStore(name)).length))
    return Object.fromEntries(names.map((name, i) => [name, counts[i]])) as Record<StoreName, number>
  }

  clearStore(name: StoreName): Promise<void> {
    return this.invoke('clearStore', name)
  }

  // Puts or deletes an entry of a store, bypassing src/storage.ts.
  putEntry(name: StoreName, key: string, value: unknown): Promise<void> {
    return this.invoke('putEntry', name, key, value)
  }

  deleteEntry(name: StoreName, key: string): Promise<void> {
    return this.invoke('deleteEntry', name, key)
  }

  // Makes every write to a store (or to one key of it) fail, until
  // stopFailing: refused at once (a synchronous throw), or aborted once it
  // has succeeded (the transaction failing at commit, asynchronously).
  failWrites(store: StoreName, key: string | null = null, how: FailWrites = 'refused'): Promise<void> {
    return this.invoke('failWrites', store, key, how)
  }

  stopFailing(): Promise<void> {
    return this.invoke('stopFailing')
  }

  listen(): Promise<void> {
    return this.invoke('listen')
  }

  heard(): Promise<{ account: boolean; matches: string[] | 'all'; revision: number }[]> {
    return this.invoke('heard')
  }

  // Reloads the page and waits for its script.
  async reload() {
    await this.page.reload()
    await this.page.waitForFunction(() => 'storageHarness' in window)
  }

  private invoke<T>(name: string, ...args: unknown[]): Promise<T> {
    return this.page.evaluate(
      ([name, args]) =>
        (
          window as unknown as {
            storageHarness: Record<string, (...args: unknown[]) => Promise<unknown>>
          }
        ).storageHarness[name as string](...(args as unknown[])),
      [name, args] as const,
    ) as Promise<T>
  }

  private call<
    Name extends
      | 'kept'
      | 'loadMe'
      | 'storeOwnHello'
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
