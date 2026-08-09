import { EVERY_SETTING_AUTOMATIC } from '@/mocks/factories/tournaments/tournament.factory'

import {
  MANUAL_POOL_DIMENSION_MAX,
  MEMBERSHIP_MANUAL_VALUE,
  acceptedManualEntry,
  apiToDrawOwnership,
  drawOwnershipToApi,
  everySettingAutomatic,
  ownedStructureSettings,
  type DrawOwnership,
} from './draw-ownership'
import type { SettingOwnership } from './draw-structure'

/** Compile-time, not a runtime assertion: the three numeric settings' modes ARE the
 * derivation's `SettingOwnership`, so a row hands its stored mode straight to
 * `deriveDrawStructure` with no cast and there is no second enum to drift. Both
 * directions, because one alone would admit a mode the derivation cannot read. */
const _modeIsOwnership: SettingOwnership = 'manual' satisfies DrawOwnership['poolCountMode']
const _ownershipIsMode: DrawOwnership['poolSizeMode'] =
  'automatic' satisfies SettingOwnership
void _modeIsOwnership
void _ownershipIsMode

describe('everySettingAutomatic', () => {
  it('is today’s behaviour: nothing taken, and the snake deals', () => {
    expect(everySettingAutomatic()).toEqual({
      poolCountMode: 'automatic',
      manualPoolCount: null,
      poolSizeMode: 'automatic',
      manualPoolSize: null,
      qualifiersMode: 'automatic',
      membershipMode: 'snake',
    })
  })

  /**
   * ⚠️ The reason it is a function. A shared constant would be one object every event's
   * toggle rewrote — and `as const`'s readonly modifiers are **not** checked on
   * assignment, so nothing in the type system would have said so. The failure would be an
   * unrelated event's pool count turning `Yours` on a page nobody edited.
   */
  it('mints a fresh record every call, so one event’s toggle is one event’s', () => {
    const mine = everySettingAutomatic()
    const yours = everySettingAutomatic()

    mine.poolCountMode = 'manual'
    mine.manualPoolCount = 6

    expect(yours.poolCountMode).toBe('automatic')
    expect(yours.manualPoolCount).toBeNull()
  })
})

describe('apiToDrawOwnership', () => {
  it('renames the wire’s keys into this client’s vocabulary', () => {
    expect(
      apiToDrawOwnership({
        pool_count_mode: 'manual',
        manual_pool_count: 6,
        pool_size_mode: 'manual',
        manual_pool_size: 5,
        qualifiers_mode: 'manual',
        membership_mode: 'manual',
      }),
    ).toEqual({
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'manual',
      manualPoolSize: 5,
      qualifiersMode: 'manual',
      membershipMode: 'manual',
    })
  })

  // The three draw types with no pool stage send `null`, and a payload that omits the key
  // means the same thing. Absent and null are one state — no structure — so a reader
  // models one thing rather than three.
  it.each([null, undefined])('reads %s as no structure at all', (missing) => {
    expect(apiToDrawOwnership(missing)).toBeNull()
  })

  it('fills in a manual number the server left out', () => {
    const parsed = apiToDrawOwnership({
      pool_count_mode: 'automatic',
      pool_size_mode: 'automatic',
      qualifiers_mode: 'automatic',
      membership_mode: 'snake',
    })

    expect(parsed?.manualPoolCount).toBeNull()
    expect(parsed?.manualPoolSize).toBeNull()
  })

  /**
   * PARSED, not cast. The three payloads below are ones `schema.d.ts` says cannot exist —
   * which is the point: it is a compile-time claim about a server this client does not
   * control, and each of these would otherwise surface far from the response that carried
   * it. A `0` is the sharpest: it is what a cleared box authors through `Number('')`, and
   * it is a 422 on the way back out.
   */
  it.each([
    ['a manual count of zero', { manual_pool_count: 0 }],
    ['a manual size past the server’s ceiling', { manual_pool_size: 513 }],
    ['a fractional manual count', { manual_pool_count: 3.5 }],
    ['a mode this client does not know', { pool_count_mode: 'inherited' }],
    ['a membership mode this client does not know', { membership_mode: 'random' }],
  ])('refuses %s, at the boundary', (_case, broken) => {
    expect(() =>
      apiToDrawOwnership({
        ...EVERY_SETTING_AUTOMATIC,
        ...broken,
      } as Parameters<typeof apiToDrawOwnership>[0]),
    ).toThrow()
  })
})

describe('drawOwnershipToApi', () => {
  it('renames this client’s keys back onto the wire', () => {
    expect(
      drawOwnershipToApi({
        ...everySettingAutomatic(),
        poolSizeMode: 'manual',
        manualPoolSize: 5,
      }),
    ).toEqual({
      pool_count_mode: 'automatic',
      manual_pool_count: null,
      pool_size_mode: 'manual',
      manual_pool_size: 5,
      qualifiers_mode: 'automatic',
      membership_mode: 'snake',
    })
  })

  // An event that never had a record still sends one: the editor puts back what it
  // rendered, and what it rendered is every setting the system's.
  it('sends the all-automatic record for an event that has none', () => {
    expect(drawOwnershipToApi(null)).toEqual(EVERY_SETTING_AUTOMATIC)
  })

  it('round-trips: everything the wire holds survives both mappers', () => {
    const taken: DrawOwnership = {
      poolCountMode: 'manual',
      manualPoolCount: 6,
      poolSizeMode: 'automatic',
      // Kept while the mode is automatic — the director's number, remembered.
      manualPoolSize: 5,
      qualifiersMode: 'manual',
      membershipMode: 'manual',
    }

    expect(apiToDrawOwnership(drawOwnershipToApi(taken))).toEqual(taken)
  })
})

/**
 * The **keystroke boundary** — the reason nothing downstream has to defend against a `0`,
 * and the reason the box needs no error slot.
 */
describe('acceptedManualEntry', () => {
  it('reads a typed number the server’s bounds admit', () => {
    expect(acceptedManualEntry('6', MANUAL_POOL_DIMENSION_MAX)).toBe(6)
    expect(acceptedManualEntry('512', MANUAL_POOL_DIMENSION_MAX)).toBe(512)
  })

  // ⚠️ `Number('')` is `0`, and a `0` is a 422 AND a draw of no pools. A cleared box is a
  // director who has not set this, which is `null` and a real state.
  it('reads a cleared box as null, never as a zero', () => {
    expect(acceptedManualEntry('', MANUAL_POOL_DIMENSION_MAX)).toBeNull()
    expect(acceptedManualEntry('   ', MANUAL_POOL_DIMENSION_MAX)).toBeNull()
  })

  /**
   * `undefined` is "not a value this box may hold", so the keystroke is dropped and the
   * box keeps the number the director last chose.
   *
   * ⚠️ It is deliberately NOT clamped to the bound: turning a pasted `600` into `512`
   * would be the system silently changing a director's number, which is the one thing ADR
   * 20260808 says it never does.
   */
  it.each([
    ['a typed zero', '0'],
    ['past the ceiling', '600'],
    ['a fraction', '3.5'],
    ['a negative', '-4'],
    ['exponent notation', '1e3'],
    ['words', 'six'],
  ])('refuses %s, and does not clamp it', (_case, typed) => {
    expect(acceptedManualEntry(typed, MANUAL_POOL_DIMENSION_MAX)).toBeUndefined()
  })

  // The ceiling is the caller's, because the two settings have different ones: 512 for a
  // pool dimension, 1,000 for a qualifier count.
  it('bounds against the ceiling it was given', () => {
    expect(acceptedManualEntry('600', 1000)).toBe(600)
    expect(acceptedManualEntry('600', 512)).toBeUndefined()
  })
})

/**
 * **What the director owns right now** — the list a draw-type change has to price before
 * it discards it (ADR 20260808).
 *
 * The claim under every case is one sentence: this names exactly the settings whose badge
 * reads `Yours`. The badge is `deriveDrawStructure`'s (`./draw-structure`), and this
 * restates its rule rather than calling it, so the cases below are where the two are held
 * together.
 */
describe('ownedStructureSettings', () => {
  /** An event that has never seen the tab, and the three draw types that have no tab at
   * all. Both mean the same thing: no record, so nothing is anybody's. */
  it('finds nothing on an event with no record at all', () => {
    expect(ownedStructureSettings(null, 2)).toEqual([])
  })

  it('finds nothing while every setting is the system’s', () => {
    expect(ownedStructureSettings(everySettingAutomatic(), 2)).toEqual([])
  })

  /** #1320's own example, read back: a pool count of 6 and a pool size of 5. */
  it('reads back the numbers the director set, in the tab’s row order', () => {
    expect(
      ownedStructureSettings(
        {
          ...everySettingAutomatic(),
          poolCountMode: 'manual',
          manualPoolCount: 6,
          poolSizeMode: 'manual',
          manualPoolSize: 5,
        },
        2,
      ),
    ).toEqual([
      { label: 'Pool count', value: '6' },
      { label: 'Pool size', value: '5' },
    ])
  })

  /** Membership is the director's choice too, and the one setting with no number: the
   * mode IS the setting, so a manual mode is owned on its own. */
  it('counts membership, and names the phrase the row shows', () => {
    expect(
      ownedStructureSettings(
        { ...everySettingAutomatic(), membershipMode: 'manual' },
        2,
      ),
    ).toEqual([{ label: 'Membership', value: MEMBERSHIP_MANUAL_VALUE }])
  })

  /** K's value is the EVENT's count — there is no `manual_qualifiers` on the wire, the
   * stored number is the manual slot — which is why it arrives as a second argument. */
  it('reads the qualifier count off the event, not off the record', () => {
    expect(
      ownedStructureSettings(
        { ...everySettingAutomatic(), qualifiersMode: 'manual' },
        3,
      ),
    ).toEqual([{ label: 'Qualifiers per pool', value: '3' }])
  })

  /**
   * ⚠️ **A manual mode with an empty box owns nothing**, and this is the case that keeps
   * the list honest against the badge. `deriveDrawStructure` reads a manual mode with no
   * number as automatic and says `Automatic` on the row — so naming it here would price a
   * loss the director cannot see anywhere on screen.
   */
  it.each([
    [
      'a cleared pool count',
      { poolCountMode: 'manual', manualPoolCount: null } as const,
      2,
    ],
    [
      'a cleared pool size',
      { poolSizeMode: 'manual', manualPoolSize: null } as const,
      2,
    ],
    ['a cleared qualifier count', { qualifiersMode: 'manual' } as const, null],
  ] as const)('finds nothing for %s', (_case, patch, qualifiers) => {
    expect(
      ownedStructureSettings({ ...everySettingAutomatic(), ...patch }, qualifiers),
    ).toEqual([])
  })

  /** All four at once, which is also the order the Draw structure tab lists them in. */
  it('lists all four in row order', () => {
    expect(
      ownedStructureSettings(
        {
          poolCountMode: 'manual',
          manualPoolCount: 4,
          poolSizeMode: 'manual',
          manualPoolSize: 8,
          qualifiersMode: 'manual',
          membershipMode: 'manual',
        },
        2,
      ).map((setting) => setting.label),
    ).toEqual(['Pool count', 'Pool size', 'Membership', 'Qualifiers per pool'])
  })
})
