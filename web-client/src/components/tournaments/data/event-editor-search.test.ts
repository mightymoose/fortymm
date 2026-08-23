import { describe, expect, it } from 'vitest'

import { mockUuid } from '@/mocks/mock-uuid'

import { eventEditorSearchSchema, NEW_EVENT_PARAM } from './event-editor-search'

/**
 * The `?event=` boundary itself (#1503).
 *
 * Pinned here rather than through the route, because the route cannot see it: a
 * component test's only observable is "the editor stayed closed", and that is equally
 * true of a value the schema DROPPED and a well-formed uuid that simply names no event
 * on this tournament. Two different refusals, one indistinguishable screen — so the
 * route specs went green against a route module with `validateSearch` deleted.
 * (`router.state.location.search` does not settle it either: that is the raw query
 * object, not the validator's output.)
 *
 * This is the parse-at-the-boundary rule's own test
 * (`.claude/rules/parse-at-boundaries.md`): a garbage query string must become a URL
 * that names nothing, before anything downstream has to defend against it.
 */
describe('eventEditorSearchSchema — the ?event= boundary', () => {
  const EVENT_ID = mockUuid('event-editor-search-test')

  it('keeps a uuid, which is how an existing event names its editor', () => {
    expect(eventEditorSearchSchema.parse({ event: EVENT_ID })).toEqual({
      event: EVENT_ID,
    })
  })

  it('keeps the `new` sentinel, which is how the UNSAVED editor names itself', () => {
    // An event that does not exist yet has no uuid to be named by.
    expect(eventEditorSearchSchema.parse({ event: NEW_EVENT_PARAM })).toEqual({
      event: 'new',
    })
  })

  it.each([
    ['a value that is neither a uuid nor `new`', 'not-a-uuid'],
    ['an empty value', ''],
    ['a uuid-ish value that is not one', '00000000-0000-4000-8000-00000000000'],
    ['the sentinel in the wrong case', 'NEW'],
    ['a non-string', 42],
  ])('drops %s entirely', (_label, value) => {
    // Dropped, never carried inward: `{}` is what "no editor is open" actually is, and
    // it is the same value the page gets for a URL with no `?event=` at all.
    expect(eventEditorSearchSchema.parse({ event: value })).toEqual({})
  })

  it('leaves NO phantom `event` key behind when the value is refused', () => {
    // The reason the catch is on the OBJECT and not on the field. A field-level
    // `.catch(undefined)` always produces the key, so a tournament with no editor open
    // would carry `{ event: undefined }` — a search record with an entry in it, which
    // everything that walks the record then renders. `toEqual` cannot see the
    // difference; `in` can.
    const parsed: Record<string, unknown> = eventEditorSearchSchema.parse({
      event: 'not-a-uuid',
    })
    expect('event' in parsed).toBe(false)
  })

  it('accepts a URL with no `?event=` at all, and adds nothing to it', () => {
    const parsed: Record<string, unknown> = eventEditorSearchSchema.parse({})
    expect(parsed).toEqual({})
    expect('event' in parsed).toBe(false)
  })

  it('never throws, whatever the query string holds', () => {
    // A malformed query string names no editor. It must not be able to break a page
    // whose own resource is perfectly fine — that is the difference between this
    // boundary and `params.parse`, which throws `notFound()` (ADR-1001).
    expect(() => eventEditorSearchSchema.parse(undefined)).not.toThrow()
    expect(() => eventEditorSearchSchema.parse('nonsense')).not.toThrow()
    expect(() => eventEditorSearchSchema.parse({ event: {} })).not.toThrow()
  })
})
