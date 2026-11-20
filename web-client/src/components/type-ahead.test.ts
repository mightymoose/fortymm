import { afterEach, expect, test } from 'vitest'
import { dropKeys, keepKeys, takeKeys } from './type-ahead.ts'

// What is kept of the keys typed between Start match and game 1's scoring
// page (type-ahead.ts). That the page types them into its fields is the
// route's test (src/routes/matches/new.test.tsx).

afterEach(dropKeys)

function press(keys: string[]) {
  for (const key of keys) window.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }))
}

// Round 4, bug 5 (interrogate-g2c): Enter on a focused Start match presses
// it; pressed again, it is a second press of Start (which does nothing),
// not a move to the opponent's field.
test('an Enter before any digit is Start pressed again, and isn’t kept: the score typed next lands as typed', () => {
  keepKeys()

  press(['Enter', '1', '1', 'Enter', '7'])

  expect(takeKeys()).toEqual(['1', '1', 'Enter', '7'])
})

test('Tab before any digit is kept: the score typed next is the opponent’s', () => {
  keepKeys()

  press(['Tab', '7'])

  expect(takeKeys()).toEqual(['Tab', '7'])
})
