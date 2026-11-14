import { expect, test } from 'vitest'
import { formatColour } from './token-value.ts'

// Made-up colours: the rule is how a value is written, whatever the theme's
// values are.
test('an opaque colour is written as upper-case #RRGGBB', () => {
  expect(formatColour('#a1b2c3')).toBe('#A1B2C3')
})

test('a see-through colour is written as rgba(), its alpha to two places', () => {
  expect(formatColour('#10203024')).toBe('rgba(16,32,48,0.14)')
  expect(formatColour('#1020301a')).toBe('rgba(16,32,48,0.10)')
})

test('a value that is not a hex colour is left as it is', () => {
  expect(formatColour('4px')).toBe('4px')
})
