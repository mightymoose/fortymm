import { afterEach, describe, expect, it, vi } from 'vitest'
import { uuidv7 } from './uuidv7'

describe('uuidv7', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is a version 7 UUID of the time it was made', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 4, 12, 0, 0) })
    const id = uuidv7()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 4, 12, 0, 0))
  })

  it('makes a new id each time', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 0 })
    expect(uuidv7()).not.toBe(uuidv7())
  })
})
