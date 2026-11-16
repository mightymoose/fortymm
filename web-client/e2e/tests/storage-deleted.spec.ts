import type { Page } from '@playwright/test'
import { expect, test } from '../pages/test.ts'
import { StorageHarness } from '../pages/storage.ts'

// Storage (src/storage.ts) while its database is being deleted: what a
// future "reset this device", a version upgrade with two tabs open, or
// DevTools does. A delete waits for every open connection to close, and
// every open after it waits for the delete. So a connection that stays open
// while its call waits for the append lock, behind a holder whose own open
// is queued behind the delete, would make every tab wait for ever (the
// second review's finding 1). Each step here has a bound: a call that
// doesn't answer fails the test by its timeout, never hangs the suite.

test.use({ build: 'harness' })

const appendLock = 'fortymm-journal-append'
const storageDatabase = 'fortymm-storage'

// How long a call may take before it counts as never answering.
const answers = { timeout: 10_000 }

type Tab = { page: Page; harness: StorageHarness }

async function tab(page: Page): Promise<Tab> {
  const harness = new StorageHarness(page)
  await harness.open()
  return { page, harness }
}

// Takes the append lock in this page and holds it until releaseLock: a
// withDeviceKey callback still busy signing, as a commit's is.
async function holdLock(page: Page) {
  await page.evaluate(
    (name) =>
      new Promise<void>((granted) => {
        void navigator.locks.request(name, () => {
          granted()
          return new Promise<void>((release) => {
            ;(window as unknown as { releaseLock: () => void }).releaseLock = release
          })
        })
      }),
    appendLock,
  )
}

async function releaseLock(page: Page) {
  await page.evaluate(() => (window as unknown as { releaseLock: () => void }).releaseLock())
}

// How many requests for the append lock wait, and how many hold it, across
// the origin.
async function locks(page: Page) {
  return page.evaluate(async (name) => {
    const state = await navigator.locks.query()
    return {
      held: (state.held ?? []).filter((lock) => lock.name === name).length,
      pending: (state.pending ?? []).filter((lock) => lock.name === name).length,
    }
  }, appendLock)
}

// Asks the browser to delete the storage database, from this page; deleted()
// gives 'pending', 'blocked' (open connections hold it back), 'deleted' or
// 'error'.
async function deleteDatabase(page: Page) {
  await page.evaluate((name) => {
    const state = window as unknown as { deletion: string }
    state.deletion = 'pending'
    const request = indexedDB.deleteDatabase(name)
    request.onblocked = () => (state.deletion = 'blocked')
    request.onsuccess = () => (state.deletion = 'deleted')
    request.onerror = () => (state.deletion = 'error')
  }, storageDatabase)
}

function deleted(page: Page): Promise<string> {
  return page.evaluate(() => (window as unknown as { deletion: string }).deletion)
}

for (const waiting of ['rebuildViews', 'storeRecord'] as const) {
  test(`a delete of the database while ${waiting} waits for the append lock goes through, and the commit holding the lock, ${waiting} and a later read each answer`, async ({
    context,
    page,
  }) => {
    test.setTimeout(60_000)
    const first = await tab(page)
    const [player] = await first.harness.makeRecords([{ kind: 'player' }])
    const [match] = await first.harness.makeRecords([
      { kind: 'match', opponent: player.player!, bestOf: 5, rated: false },
    ])
    expect(await first.harness.append([player.record, match.record])).toEqual({ ok: true })
    // Made before the lock is taken: making it takes the lock too.
    const hello = await first.harness.hello()
    const [holder, committer, waiter, deleter] = [
      await tab(await context.newPage()),
      await tab(await context.newPage()),
      await tab(await context.newPage()),
      await tab(await context.newPage()),
    ]

    // A commit's callback holds the lock; a second commit waits for it, to
    // read the match inside it; then the call under test waits too.
    await holdLock(holder.page)
    await committer.harness.start('held', 'heldLoadMatch', match.id)
    await expect.poll(() => locks(page)).toEqual({ held: 1, pending: 1 })
    if (waiting === 'rebuildViews') await waiter.harness.start('waiting', 'rebuildViews')
    else await waiter.harness.start('waiting', 'storeRecord', hello)
    await expect.poll(() => locks(page)).toEqual({ held: 1, pending: 2 })
    await deleteDatabase(deleter.page)
    await releaseLock(holder.page)

    await expect.poll(() => deleted(deleter.page), answers).toBe('deleted')
    // Each then runs on a database made afresh: no match is kept there.
    await expect.poll(() => committer.harness.answer('held'), answers).toEqual({
      ok: true,
      match: null,
    })
    await expect.poll(() => waiter.harness.answer('waiting'), answers).toEqual({ ok: true })
    await deleter.harness.start('list', 'loadMatches')
    await expect.poll(() => deleter.harness.answer('list'), answers).toEqual({
      ok: true,
      matches: [],
    })
    expect(await locks(page)).toEqual({ held: 0, pending: 0 })
  })
}
