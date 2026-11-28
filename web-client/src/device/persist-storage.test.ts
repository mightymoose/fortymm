import { afterEach, describe, expect, vi } from 'vitest'
import { it } from '../setupTests.ts'
import { persistStorage } from './persist-storage.ts'

// A StorageManager stand-in: already persistent or not, and what persist() answers.
function storage(persisted: boolean, grants: boolean) {
  return {
    persisted: vi.fn(async () => persisted),
    persist: vi.fn(async () => grants),
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('persistStorage', () => {
  it('is unavailable without StorageManager persistence', async () => {
    vi.stubGlobal('navigator', { storage: undefined })
    expect(await persistStorage()).toBe('unavailable')
  })

  it('is already-persisted when the storage is persistent', async () => {
    vi.stubGlobal('navigator', { storage: storage(true, true) })
    expect(await persistStorage()).toBe('already-persisted')
  })

  it('does not ask again when the storage is persistent', async () => {
    const manager = storage(true, true)
    vi.stubGlobal('navigator', { storage: manager })
    await persistStorage()
    expect(manager.persist).not.toHaveBeenCalled()
  })

  it('is persisted when the browser grants it', async () => {
    vi.stubGlobal('navigator', { storage: storage(false, true) })
    expect(await persistStorage()).toBe('persisted')
  })

  it('is refused when the browser says no', async () => {
    vi.stubGlobal('navigator', { storage: storage(false, false) })
    expect(await persistStorage()).toBe('refused')
  })

  it('is unavailable when asking fails', async () => {
    vi.stubGlobal('navigator', {
      storage: {
        persisted: async () => false,
        persist: () => Promise.reject(new DOMException('Failed', 'InvalidStateError')),
      },
    })
    expect(await persistStorage()).toBe('unavailable')
  })
})
