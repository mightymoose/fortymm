import { expect, test } from 'vitest'
import { initials } from './initials.ts'

test('the initials of a generated username are the first letters of its first two words', () => {
  expect(initials('agile-meerkat-4b8z')).toBe('AM')
})

test('the initials of a one-word name are its first letter', () => {
  expect(initials('solo')).toBe('S')
})

test('the initials of a name of three words are those of its first two', () => {
  expect(initials('a-b-c')).toBe('AB')
})

test('an empty name has no initials', () => {
  expect(initials('')).toBe('')
})
