import { describe, expect, it } from 'vitest'
import { uuidv7 } from './uuidv7'

describe('uuidv7', () => {
  it('is a version 7 UUID of the time it was made', () => {
    const id = uuidv7(Date.UTC(2026, 10, 4, 12, 0, 0))
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(parseInt(id.replaceAll('-', '').slice(0, 12), 16)).toBe(Date.UTC(2026, 10, 4, 12, 0, 0))
  })

  it('makes a new id each time', () => {
    expect(uuidv7(0)).not.toBe(uuidv7(0))
  })
})
