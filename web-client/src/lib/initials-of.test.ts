import { describe, expect, it } from 'vitest'

import { initialsOf } from './initials-of'

describe('initialsOf', () => {
  describe('two-or-more parts → first letter of the first two', () => {
    it.each([
      ['space-separated name', 'John Smith', 'JS'],
      ['dotted username', 'rita.kovac', 'RK'],
      ['underscore separator', 'john_smith', 'JS'],
      ['hyphen separator', 'mary-jane', 'MJ'],
      ['ignores all parts after the second', 'jean.luc.picard', 'JL'],
      ['four parts still only uses two', 'a.b.c.d', 'AB'],
      ['second part starting with a digit', 'agent 007', 'A0'],
      ['tabs and newlines count as whitespace', 'john\tsmith', 'JS'],
    ])('%s: %j → %j', (_label, input, expected) => {
      expect(initialsOf(input)).toBe(expected)
    })
  })

  describe('single part → first two characters', () => {
    it.each([
      ['multi-letter single name', 'alice', 'AL'],
      ['one-character name', 'a', 'A'],
      ['name with trailing digits', 'bob123', 'BO'],
    ])('%s: %j → %j', (_label, input, expected) => {
      expect(initialsOf(input)).toBe(expected)
    })
  })

  describe('uppercases the result', () => {
    it('upcases lowercase ASCII', () => {
      expect(initialsOf('li wei')).toBe('LW')
      expect(initialsOf('alice')).toBe('AL')
    })

    it('leaves already-uppercase input uppercase', () => {
      expect(initialsOf('Foo Bar')).toBe('FB')
    })

    it('upcases non-ASCII letters', () => {
      expect(initialsOf('élodie dubois')).toBe('ÉD')
    })
  })

  describe('collapses runs of separators and trims edges', () => {
    it.each([
      ['repeated dots', 'john..smith', 'JS'],
      ['mixed adjacent separators', 'john -  smith', 'JS'],
      ['leading separator', '.alice', 'AL'],
      ['trailing separator', 'alice.', 'AL'],
      ['surrounding whitespace', '  bob  ', 'BO'],
    ])('%s: %j → %j', (_label, input, expected) => {
      expect(initialsOf(input)).toBe(expected)
    })
  })

  describe('zero parts → first two characters of the raw input', () => {
    it('returns empty string for empty input', () => {
      // user-avatar.tsx relies on '' for empty input.
      expect(initialsOf('')).toBe('')
    })

    it('returns the first two raw chars when the input is only separators', () => {
      expect(initialsOf('...')).toBe('..')
    })

    it('whitespace-only input yields its first two (space) chars', () => {
      expect(initialsOf('   ')).toBe('  ')
    })
  })

  describe('characters outside the separator set are not split on', () => {
    it('passes a lone ellipsis through unchanged', () => {
      // '…' (U+2026) is not in the [.\s_-] split set, so it is treated as a
      // single one-character part. user-avatar.tsx depends on this passthrough.
      expect(initialsOf('…')).toBe('…')
    })
  })
})
