import type { ReadOnlyValueContent } from './read-only-value'
import { readOnlyValuePage } from './read-only-value.page'

/** U+2014 — the character the ADR pins for an empty field. */
const EM_DASH = '—'

describe('ReadOnlyValue', () => {
  it('renders a string value as plain text', () => {
    readOnlyValuePage.render({ children: 'Open Singles' })
    expect(readOnlyValuePage.getValue().textContent).toBe('Open Singles')
  })

  it('renders a number value as plain text', () => {
    readOnlyValuePage.render({ children: 32 })
    expect(readOnlyValuePage.getValue().textContent).toBe('32')
  })

  // An unset field renders an em-dash rather than an omitted row: absent and
  // not-applicable must stay distinguishable (ADR 0015).
  it.each<[string, ReadOnlyValueContent]>([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a whitespace-only string', '   '],
  ])('renders an em-dash when the value is %s', (_label, value) => {
    readOnlyValuePage.render({ children: value })
    expect(readOnlyValuePage.getValue().textContent).toBe(EM_DASH)
  })

  // The boundary a falsy check gets wrong: these are values the organizer
  // chose, not an empty field. `false` is the sharper case — React renders a
  // bare `{false}` as nothing at all.
  it.each<[string, ReadOnlyValueContent, string]>([
    ['zero', 0, '0'],
    ['false', false, 'false'],
    ['true', true, 'true'],
  ])('renders %s as itself rather than as an em-dash', (_label, value, text) => {
    readOnlyValuePage.render({ children: value })
    expect(readOnlyValuePage.getValue().textContent).toBe(text)
  })

  it('puts no interactive control in the accessibility tree', () => {
    readOnlyValuePage.render({ children: 'Open Singles' })
    expect(readOnlyValuePage.getInteractiveControls()).toHaveLength(0)
    expect(readOnlyValuePage.getFocusableElements()).toHaveLength(0)
  })

  it('holds the row height and type scale of the input it replaces', () => {
    readOnlyValuePage.render()
    expect(readOnlyValuePage.getValue()).toHaveClass(
      'h-10',
      'items-center',
      'text-sm',
    )
  })

  it('accepts a caller className alongside its own', () => {
    readOnlyValuePage.render({ className: 'font-mono' })
    expect(readOnlyValuePage.getValue()).toHaveClass('font-mono', 'text-sm')
  })
})
