import { describe, expect, it } from 'vitest'

import {
  MAX_EMAIL_LENGTH,
  MAX_EMAIL_LOCAL_PART_LENGTH,
  isValidEmail,
} from './form-helpers'

describe('isValidEmail', () => {
  it('accepts an ordinary address', () => {
    expect(isValidEmail('rita@example.com')).toBe(true)
  })

  it('rejects a malformed address', () => {
    expect(isValidEmail('not-an-email')).toBe(false)
  })

  it('rejects an address longer than the RFC 5321 cap', () => {
    const tooLong = `${'a'.repeat(MAX_EMAIL_LENGTH)}@example.com`
    expect(isValidEmail(tooLong)).toBe(false)
  })

  it('accepts a 64-char local part but rejects a 65-char one (#615)', () => {
    const max = `${'a'.repeat(MAX_EMAIL_LOCAL_PART_LENGTH)}@example.com`
    const over = `${'a'.repeat(MAX_EMAIL_LOCAL_PART_LENGTH + 1)}@example.com`
    expect(isValidEmail(max)).toBe(true)
    expect(isValidEmail(over)).toBe(false)
  })
})
