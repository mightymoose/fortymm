import { describe, expect, it } from 'vitest'

import {
  isAcceptableScoreInput,
  validateGameScore,
} from './validate-game-score'

describe('validateGameScore', () => {
  it('accepts a legal decided final score', () => {
    expect(validateGameScore('11', '7')).toEqual({
      valid: true,
      oneSideFilled: false,
      error: null,
      meMalformed: false,
      oppMalformed: false,
    })
  })

  it('does not flag a wholly-empty pair (the untouched initial state)', () => {
    const v = validateGameScore('', '')
    expect(v.valid).toBe(false)
    expect(v.oneSideFilled).toBe(false)
    expect(v.error).toBeNull()
  })

  it('flags exactly one side filled as oneSideFilled with no hard error', () => {
    const v = validateGameScore('11', '')
    expect(v.oneSideFilled).toBe(true)
    expect(v.error).toBeNull()
    expect(v.valid).toBe(false)
  })

  it('reports a format error and the malformed side for a decimal entry', () => {
    const v = validateGameScore('11.5', '7')
    expect(v.meMalformed).toBe(true)
    expect(v.oppMalformed).toBe(false)
    expect(v.error).toBe('Enter each score as a whole number from 0 to 99.')
    expect(v.valid).toBe(false)
  })

  it('reports a format error for an over-long run of digits', () => {
    const v = validateGameScore('11', '999')
    expect(v.oppMalformed).toBe(true)
    expect(v.error).toBe('Enter each score as a whole number from 0 to 99.')
  })

  it('surfaces the illegal-score reason for a score above the 99 cap', () => {
    const v = validateGameScore('101', '99')
    expect(v.meMalformed).toBe(true)
    expect(v.error).toBe('Enter each score as a whole number from 0 to 99.')
  })

  it('surfaces the illegal-score reason for a tie', () => {
    const v = validateGameScore('11', '11')
    expect(v.meMalformed).toBe(false)
    expect(v.oppMalformed).toBe(false)
    expect(v.error).toBe('A game cannot end in a tie.')
    expect(v.valid).toBe(false)
  })

  it('surfaces the illegal-score reason for a sub-11 winner', () => {
    const v = validateGameScore('9', '7')
    expect(v.error).toBe('The winning side must reach at least 11 points.')
  })
})

describe('isAcceptableScoreInput', () => {
  it('keeps digits and a decimal point', () => {
    expect(isAcceptableScoreInput('11')).toBe(true)
    expect(isAcceptableScoreInput('11.')).toBe(true)
    expect(isAcceptableScoreInput('')).toBe(true)
  })

  it('rejects letters and signs', () => {
    expect(isAcceptableScoreInput('1a')).toBe(false)
    expect(isAcceptableScoreInput('-1')).toBe(false)
  })
})
