import { expect, test } from 'vitest'
import { opponentInitials, opponentLabel } from './opponent.ts'

test.each([
  { name: 'Ana', label: 'Ana' },
  { name: null, label: 'Anonymous' },
])('the label of opponent $name is $label', ({ name, label }) => {
  expect(opponentLabel(name)).toBe(label)
})

test.each([
  { name: 'Ana', initials: 'A' },
  { name: 'Bea Okafor', initials: 'BO' },
  { name: null, initials: '?' },
])('the initials of opponent $name are $initials', ({ name, initials }) => {
  expect(opponentInitials(name)).toBe(initials)
})
