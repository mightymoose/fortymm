import type { components } from '@/api/schema'

import {
  DRAW_TYPES,
  parseDrawTypeCatalogue,
  STAGE_DRAW_TYPES,
  type DrawType,
} from './draw-types'

/** One row of the served catalogue, in the wire's shape. Hand-written (not spread from
 * a domain fixture) because this is what the *parser* is fed — a plain JSON object off
 * a response, untrusted until it has been through `parseDrawTypeCatalogue`. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  key: 'round-robin',
  name: 'Round robin',
  description: 'Everyone in a group plays everyone else in that group.',
  display_order: 1,
  ...over,
})

/** The DRAW TYPE vocabulary — a contract with the API, not a menu (ADR 20260726 "a draw
 * type is a seeded row, and the enum holds only what runs").
 *
 * `DrawType` used to name five types while the server could plan two, so a director
 * could pick "Swiss" from the picker, create the event, enter a whole field, and only
 * discover at the moment they cut the draw that it was never possible. The API's enum
 * now holds exactly what runs, and what does not is a **422 at the request boundary** —
 * a set that moves in both directions: `rr-then-ko` was removed with the other three and
 * came back in #1227 the moment its strategy landed, and `swiss` came back the same way
 * when `SwissStrategy` learned to cut a draw.
 *
 * What survives on the client is a *vocabulary*, not an offer, and it is declared
 * **once**: `DRAW_TYPES` in `./draw-types`, with `drawTypeSchema` (the event form's
 * validator), the `DrawType` union and the catalogue parser's filter all derived from
 * it. The labels are gone — those are the server's now — but the set of slugs still has
 * to match `schema.d.ts`, and nothing but this file makes it. */
describe('the draw-type vocabulary (a contract with the API, not a menu)', () => {
  /** The generated enum, straight off `schema.d.ts` — never re-typed here, or the pin
   * would be two lists agreeing with each other rather than with the server. */
  type WireDrawType = components['schemas']['DrawType']

  /** The pin that binds the whole vocabulary to the server. `DrawType` is inferred
   * from `DRAW_TYPES`, so this fails if a member of the API's enum is *missing* from
   * that array (a seeded row the picker would silently drop, and a slug the form would
   * refuse); the array's own `satisfies` blocks the other direction, an *extra* slug
   * the API would 422. One declaration, both directions covered. */
  it('is EXACTLY the API’s enum — no client-only member can exist', () => {
    expectTypeOf<DrawType>().toEqualTypeOf<WireDrawType>()
    expectTypeOf<(typeof DRAW_TYPES)[number]>().toEqualTypeOf<DrawType>()
  })

  it('makes a draw type the server would 422 a compile error', () => {
    // @ts-expect-error 'double-elim' is not in the API's enum — nothing can plan it.
    const drawType: DrawType = 'double-elim'
    expect(drawType).toBe('double-elim')
  })
})

/** `STAGE_DRAW_TYPES` is `DRAW_TYPES` minus `rr-then-ko` (ADR 20260815 decision 4: a
 * stage's own draw type is always single-stage) — pinned here, rather than left to two
 * lists that happen to agree, so a fifth draw type added to `DRAW_TYPES` without a
 * ruling on whether it is single-stage is caught the moment it lands, not the moment
 * `shapeForStage` (`./draw`) is asked to switch on it. */
describe('STAGE_DRAW_TYPES (a stage’s own draw type is never a template)', () => {
  it('is every DRAW_TYPES member except rr-then-ko', () => {
    expect(STAGE_DRAW_TYPES).toEqual(DRAW_TYPES.filter((t) => t !== 'rr-then-ko'))
  })

  it('does not hold rr-then-ko', () => {
    expect(STAGE_DRAW_TYPES).not.toContain('rr-then-ko')
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
      row({ key: 'double-elim', name: 'Double elimination', display_order: 2 }),
    ])

    expect(options).toEqual([{ value: 'round-robin', label: 'Round robin' }])
  })

  /** The sharp edge of the rule above, and the reason `DRAW_TYPES` is not a formality:
   * "unknown slug" and "slug this build simply forgot to list" are indistinguishable
   * here, and both are dropped **silently**. `rr-then-ko` is the row that proved it —
   * seeded on the server, in the payload, and absent from the picker with nothing said
   * (ADR "rr-then-ko cuts both stages upfront and seeds qualifiers rematch-free",
   * Context). This pins the served row all the way through the filter. */
  it('keeps the rr-then-ko row the server seeds, rather than dropping it', () => {
    // The slug is written out, NOT mapped from `DRAW_TYPES` — a test that fed the parser
    // its own allowlist would agree with itself in every state, including the broken one.
    const options = parseDrawTypeCatalogue([
      row({ key: 'round-robin', name: 'Round robin', display_order: 1 }),
      row({
        key: 'rr-then-ko',
        name: 'Round-robin then knockout',
        display_order: 3,
      }),
    ])

    expect(options).toEqual([
      { value: 'round-robin', label: 'Round robin' },
      { value: 'rr-then-ko', label: 'Round-robin then knockout' },
    ])
  })

  /** The same pin for `swiss`, the second slug to make the trip from "a 422 at the
   * request boundary" back to "a seeded row the picker must offer" (ADR "swiss pre-cuts
   * every round and pairs each one on advance"). Written out rather than mapped from
   * `DRAW_TYPES`, for the reason the rr-then-ko case gives above. */
  it('keeps the swiss row the server seeds, rather than dropping it', () => {
    const options = parseDrawTypeCatalogue([
      row({ key: 'round-robin', name: 'Round robin', display_order: 1 }),
      row({ key: 'swiss', name: 'Swiss', display_order: 4 }),
    ])

    expect(options).toEqual([
      { value: 'round-robin', label: 'Round robin' },
      { value: 'swiss', label: 'Swiss' },
    ])
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
