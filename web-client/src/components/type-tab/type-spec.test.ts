import { expect, test } from 'vitest'
import { typeSpec, type ComputedType } from './type-spec.ts'

// Made-up families and colours: the rule is how a computed style is
// described, whatever the theme's values are.
const tokens = {
  numFamily: "'Numbers Face',monospace",
  displayFamily: "'Display Face','Words Face',sans-serif",
  colours: { 'fg-2': '#102030', 'fg-3': '#405060' },
}

const ui = '"Words Face", sans-serif'
const fg1 = 'rgb(1, 2, 3)'

function computed(style: Partial<ComputedType>): ComputedType {
  return {
    fontFamily: ui,
    fontSize: '15px',
    lineHeight: '22.5px',
    fontWeight: '400',
    letterSpacing: 'normal',
    color: fg1,
    ...style,
  }
}

test('a heading in the UI family reads size / line height / weight / letter spacing', () => {
  expect(
    typeSpec(
      computed({
        fontSize: '48px',
        lineHeight: '52.8px',
        fontWeight: '700',
        letterSpacing: '-0.96px',
      }),
      tokens,
    ),
  ).toBe('48 / 1.1 / 700 / -0.02em')
})

test('a style with no letter spacing leaves it out', () => {
  expect(
    typeSpec(
      computed({ fontSize: '20px', lineHeight: '26px', fontWeight: '600' }),
      tokens,
    ),
  ).toBe('20 / 1.3 / 600')
})

test('a style in a colour other than fg-1 names its colour token', () => {
  expect(
    typeSpec(computed({ color: 'rgb(16, 32, 48)' }), tokens),
  ).toBe('15 / 1.5 / 400 · fg-2')
})

test('a style in the numbers family is marked mono', () => {
  expect(
    typeSpec(
      computed({
        fontFamily: '"Numbers Face", monospace',
        fontSize: '96px',
        lineHeight: '96px',
        fontWeight: '700',
        letterSpacing: '-2.88px',
      }),
      tokens,
    ),
  ).toBe('mono 96 / 1 / 700 / -0.03em')
})

test('a style in the display family is marked Bebas', () => {
  expect(
    typeSpec(
      computed({
        fontFamily: '"Display Face", "Words Face", sans-serif',
        fontSize: '48px',
        lineHeight: '48px',
        letterSpacing: '0.48px',
      }),
      tokens,
    ),
  ).toBe('Bebas 48 / 1 / 400 / 0.01em')
})
