import type { components } from '@/api/schema'

import { eventSchema } from '../tournament-detail-page/event-form'
import { DRAW_TYPES, parseDrawTypeCatalogue } from './draw-types'
import type { DrawType } from './types'

/** One row of the served catalogue, in the wire's shape. Hand-written (not spread from
 * a domain fixture) because this is what the *parser* is fed — a plain JSON object off
 * a response, untrusted until it has been through `parseDrawTypeCatalogue`. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  key: 'round-robin',
  name: 'Round robin',
  description: 'Everyone in a pool plays everyone else in that pool.',
  display_order: 1,
  ...over,
})

/** The DRAW TYPE vocabulary — a contract with the API, not a menu (ADR 20260726 "a draw
 * type is a seeded row, and the enum holds only what runs").
 *
 * `DrawType` used to name five types while the server could plan two, so a director
 * could pick "Swiss" from the picker, create the event, enter a whole field, and only
 * discover at the moment they cut the draw that it was never possible. The API's enum
 * now holds exactly the two that run, and the three that did not are a **422 at the
 * request boundary**.
 *
 * What survives on the client is a *vocabulary*, not an offer: the domain union, the
 * form's `z.enum`, and `DRAW_TYPES` (the runtime twin the catalogue parser filters
 * with). The labels are gone from all three — those are the server's now — but the set
 * of slugs still has to match `schema.d.ts`, and nothing but this file makes it. */
describe('the draw-type vocabulary (a contract with the API, not a menu)', () => {
  /** The generated enum, straight off `schema.d.ts` — never re-typed here, or the pin
   * would be two lists agreeing with each other rather than with the server. */
  type WireDrawType = components['schemas']['DrawType']

  it('is EXACTLY the API’s enum — no client-only member can exist', () => {
    expectTypeOf<DrawType>().toEqualTypeOf<WireDrawType>()
  })

  it('is the same set the event form will accept', () => {
    type FormDrawType = ReturnType<typeof eventSchema.parse>['drawType']
    expectTypeOf<FormDrawType>().toEqualTypeOf<WireDrawType>()
  })

  /** `DRAW_TYPES` is what the catalogue parser filters unknown keys with, so a member
   * missing from it is a seeded row silently dropped from the picker. `satisfies`
   * already blocks an *extra* slug at compile time; this pins the other direction. */
  it('lists every member of the union, and nothing else', () => {
    expectTypeOf<(typeof DRAW_TYPES)[number]>().toEqualTypeOf<WireDrawType>()
  })

  it('makes a draw type the server would 422 a compile error', () => {
    // @ts-expect-error 'swiss' left the API's enum — it is not a draw type any more.
    const drawType: DrawType = 'swiss'
    expect(drawType).toBe('swiss')
  })
})

/** The catalogue **is served** (ADR 20260726) — the picker renders the rows the server
 * sent, and the labels on them are the only copy for a draw type that exists anywhere.
 * This is the boundary those rows cross. */
describe('parseDrawTypeCatalogue', () => {
  it('turns the served rows into the picker’s options, in display order', () => {
    // Deliberately out of order on the wire, and NOT alphabetical either way — so a
    // parser that merely echoed the array, or sorted by label, would fail.
    const options = parseDrawTypeCatalogue([
      row({ key: 'single-elim', name: 'Single elimination', display_order: 2 }),
      row({ key: 'round-robin', name: 'Round robin', display_order: 1 }),
    ])

    expect(options).toEqual([
      { value: 'round-robin', label: 'Round robin' },
      { value: 'single-elim', label: 'Single elimination' },
    ])
  })

  /** `null` is what the LIST route sends (`api/app/tournament_list.py`): a catalogue is
   * page data for the one page that picks a draw type. It means "not sent" — which is a
   * different fact from "the server offers nothing" — and it is kept as `null` all the
   * way to the surfaces so the difference stays sayable. */
  it('keeps “no catalogue on this payload” as null, never as an empty menu', () => {
    expect(parseDrawTypeCatalogue(null)).toBeNull()
    expect(parseDrawTypeCatalogue(undefined)).toBeNull()
  })

  /** A slug this build has no word for cannot honestly be offered — picking it would
   * author a PATCH this client's own types reject. It is dropped, and the rest of the
   * catalogue still renders: a draw type seeded on the server must not be able to take
   * the whole tournament page down. */
  it('drops a draw type this build does not know, and keeps the rest', () => {
    const options = parseDrawTypeCatalogue([
      row({ key: 'round-robin', name: 'Round robin', display_order: 1 }),
      row({ key: 'swiss', name: 'Swiss', display_order: 2 }),
    ])

    expect(options).toEqual([{ value: 'round-robin', label: 'Round robin' }])
  })

  /** A malformed row is a different thing from an unknown one, and gets the other
   * answer: it throws, inside the `queryFn`, so the cache is never primed with it. A
   * nameless option is a blank menu item whose click still PATCHes a draw type — the
   * failure has to land at the response, not three components away. */
  it('throws on a row with no usable label', () => {
    expect(() => parseDrawTypeCatalogue([row({ name: '' })])).toThrow()
    expect(() => parseDrawTypeCatalogue([row({ name: undefined })])).toThrow()
  })

  it('throws when the catalogue is not a list of rows at all', () => {
    expect(() => parseDrawTypeCatalogue('round-robin')).toThrow()
    expect(() => parseDrawTypeCatalogue([{ key: 'round-robin' }])).toThrow()
  })
})
