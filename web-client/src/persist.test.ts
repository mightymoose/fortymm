import { expect, test, vi } from 'vitest'
import { createKeeping, type PersistentStorage } from './persist.ts'

// Asking the browser to keep this device's data (black-box #2), with the
// browser's storage manager stood in for: `persisted` says whether it is
// protected now, `persist` asks (and answers whether it is now).

function storage({ persisted = false, granted = false } = {}) {
  return {
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => granted),
  } satisfies PersistentStorage
}

test('after the first record is kept, it asks the browser to keep the data, once', async () => {
  const browser = storage()
  const keeping = createKeeping({ storage: () => browser, hasMatches: async () => true })

  await keeping.afterKept()
  await keeping.afterKept()

  expect(browser.persist).toHaveBeenCalledTimes(1)
})

test('on start, a device with matches that isn’t protected is asked for again', async () => {
  const browser = storage()
  const keeping = createKeeping({ storage: () => browser, hasMatches: async () => true })

  await keeping.onStart()

  expect(browser.persist).toHaveBeenCalledTimes(1)
})

test('on start, an empty device asks nothing', async () => {
  const browser = storage()
  const keeping = createKeeping({ storage: () => browser, hasMatches: async () => false })

  await keeping.onStart()

  expect(browser.persist).not.toHaveBeenCalled()
})

test('asked once on start, the first record kept in the same page asks nothing more', async () => {
  const browser = storage()
  const keeping = createKeeping({ storage: () => browser, hasMatches: async () => true })

  await keeping.onStart()
  await keeping.afterKept()

  expect(browser.persist).toHaveBeenCalledTimes(1)
})

test.each(['afterKept', 'onStart'] as const)(
  'already protected, %s asks nothing',
  async (when) => {
    const browser = storage({ persisted: true })
    const keeping = createKeeping({ storage: () => browser, hasMatches: async () => true })

    await keeping[when]()

    expect(browser.persist).not.toHaveBeenCalled()
  },
)

test.each([
  { name: 'no storage manager', manager: undefined },
  { name: 'a storage manager without persist', manager: {} },
])('without the API ($name), it does nothing and never throws', async ({ manager }) => {
  const keeping = createKeeping({
    storage: () => manager as PersistentStorage | undefined,
    hasMatches: async () => true,
  })

  await expect(keeping.afterKept()).resolves.toBeUndefined()
  await expect(keeping.onStart()).resolves.toBeUndefined()
})

test.each([
  {
    name: 'refused',
    browser: () => storage({ granted: false }),
  },
  {
    name: 'that throws',
    browser: () => ({
      persisted: vi.fn(async () => false),
      persist: vi.fn(async (): Promise<boolean> => {
        throw new Error('no')
      }),
    }),
  },
  {
    name: 'whose check throws',
    browser: () => ({
      persisted: vi.fn(async (): Promise<boolean> => {
        throw new Error('no')
      }),
      persist: vi.fn(async () => false),
    }),
  },
])('a request $name changes nothing and never throws', async ({ browser }) => {
  const keeping = createKeeping({ storage: browser, hasMatches: async () => true })

  await expect(keeping.afterKept()).resolves.toBeUndefined()
})

test('a device whose matches can’t be read asks nothing on start, and never throws', async () => {
  const browser = storage()
  const keeping = createKeeping({
    storage: () => browser,
    hasMatches: async () => {
      throw new Error('no')
    },
  })

  await expect(keeping.onStart()).resolves.toBeUndefined()
  expect(browser.persist).not.toHaveBeenCalled()
})
