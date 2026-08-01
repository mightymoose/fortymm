import type { z } from 'zod'

import {
  ENTRY_FEE_MAX,
  entryFeeSchema,
  maxPlayersSchema,
  NAME_MAX,
  nameSchema,
  PLAYERS_MAX,
  poolNameIssues,
  poolNameSchema,
  QUALIFIERS_PER_POOL_MAX,
  QUALIFIERS_PER_POOL_MIN,
  qualifiersPerPoolSchema,
} from './event-validation'

/** Longer than `tournament_events.name` (`VARCHAR(255)`) — the 422 the organizer used
 * to meet only *after* the request had gone, in Pydantic's words. */
const TOO_LONG = 'A'.repeat(NAME_MAX + 1)

/** The message a schema gives a value, or `undefined` when it accepts it. What the
 * field actually says in red is the assertion; "it failed somehow" is not. */
function messageFor(schema: z.ZodType, value: unknown): string | undefined {
  const result = schema.safeParse(value)
  return result.success ? undefined : result.error.issues[0].message
}

describe('the event name (#783 QA — the field with no guard at all)', () => {
  it('refuses a blank name, in the sibling dialog’s words', () => {
    // `NewTournamentModal` says exactly this of the tournament's name. It is the
    // same field to the person typing it; two wordings would be two rules.
    expect(messageFor(nameSchema, '')).toBe('Name is required.')
  })

  it('refuses a name that is only whitespace', () => {
    // The server trims nothing — `"   "` is 3 characters and passes `min_length=1`
    // — but an event called three spaces is not a named event.
    expect(messageFor(nameSchema, '   ')).toBe('Name is required.')
  })

  it('refuses a name past the column’s 255 characters', () => {
    expect(messageFor(nameSchema, TOO_LONG)).toBe(
      'Name must be 255 characters or fewer.',
    )
  })

  it('accepts a name of exactly 255 — the boundary the server accepts', () => {
    expect(messageFor(nameSchema, 'A'.repeat(NAME_MAX))).toBeUndefined()
  })
})

describe('the player limit (`EventMaxPlayers | None`, ADR-0935)', () => {
  /**
   * ⚠️ **THE ADR-0935 CASE, and the one a "required" rule would have un-shipped.**
   *
   * A blank box is `null` — the event has **no cap** — and that is a real, saveable
   * answer, not an error and not a `0`. The three values are one keystroke apart and
   * mean three different things, so they are asserted separately: `null` saves, `0` is
   * refused (an event admitting nobody), and `NaN` never reaches this schema because
   * the control holds a blank cap as `null`.
   */
  it('ACCEPTS a null cap — an uncapped event is a valid event', () => {
    expect(messageFor(maxPlayersSchema, null)).toBeUndefined()
  })

  it('refuses a cap of ZERO — an event admitting nobody — and says blank is the way out', () => {
    // The message names the alternative on purpose: an organizer who typed `0` wanted
    // "no limit", and a bare "must be at least 1" would send them hunting for a number.
    expect(messageFor(maxPlayersSchema, 0)).toBe(
      'The player limit must be at least 1, or blank for no cap.',
    )
  })

  it('refuses a fraction of a player', () => {
    expect(messageFor(maxPlayersSchema, 12.5)).toBe(
      'The player limit must be a whole number.',
    )
  })

  /**
   * ⚠️ **The value that DETONATED THE SERVER** (#783 QA, round three). `9999999999`
   * satisfies every rule Pydantic states (`int`, `gt=0`) — and then meets an `Integer`
   * column, which cannot hold it, and the API answers **500**. The form bounded the low
   * end and left the high end open, so the only thing standing between a typed number
   * and a server crash was the `max={512}` attribute on the input, which stops nothing
   * that is typed or pasted.
   */
  it('refuses a limit no database column could hold — the 500, caught in the form', () => {
    expect(messageFor(maxPlayersSchema, 9_999_999_999)).toBe(
      'The player limit must be 512 or fewer.',
    )
  })

  it('refuses one player past the bound, and accepts the bound itself', () => {
    expect(messageFor(maxPlayersSchema, PLAYERS_MAX + 1)).toBe(
      'The player limit must be 512 or fewer.',
    )
    // The boundary is a real answer: a 512-player draw is nine rounds of single
    // elimination, and an event that big must still save.
    expect(messageFor(maxPlayersSchema, PLAYERS_MAX)).toBeUndefined()
  })
})

/**
 * **K** — the qualifier count (`QualifiersPerPool`: `ge=1`, `le=1000`).
 *
 * The floor and its three messages already shipped; what #1231's QA pass found was the
 * OTHER end, open. The bound is asserted here as a message, not as "it failed", because
 * the number is the only thing the director can act on.
 */
describe('the qualifier count (`QualifiersPerPool`, #1231 QA)', () => {
  /** The messages that already worked, pinned so the new ceiling cannot quietly take one
   * of their places: three different faults, three different sentences. */
  it('keeps the three messages the floor already gave', () => {
    expect(messageFor(qualifiersPerPoolSchema, null)).toBe(
      'Say how many players advance from each pool.',
    )
    expect(messageFor(qualifiersPerPoolSchema, 0)).toBe(
      'At least 1 player must advance from each pool.',
    )
    expect(messageFor(qualifiersPerPoolSchema, -1)).toBe(
      'At least 1 player must advance from each pool.',
    )
    expect(messageFor(qualifiersPerPoolSchema, 1.5)).toBe(
      'Qualifiers per pool must be a whole number.',
    )
  })

  /**
   * ⚠️ **The value that DETONATED THE SERVER**, one field over from the player limit's
   * version of it. `2147483648` is one past what an `Integer` column holds: it satisfied
   * `ge=1`, went out, and came back a **500** — which the editor reported as "Something
   * went wrong on our end. Nothing you did caused it". That sentence was false. They
   * typed a number into a box, and the box had no ceiling.
   */
  it('refuses the count that 500’d the server, in words that name the limit', () => {
    expect(messageFor(qualifiersPerPoolSchema, 2_147_483_648)).toBe(
      'At most 1,000 players can advance from each pool.',
    )
  })

  /** The quieter half of the same fault, and the worse one: `999999999` was **accepted**.
   * No error anywhere — just an event whose knockout stage could never be cut. */
  it('refuses a count that saves and then cannot be drawn', () => {
    expect(messageFor(qualifiersPerPoolSchema, 999_999_999)).toBe(
      'At most 1,000 players can advance from each pool.',
    )
  })

  it('refuses one player past the bound, and accepts the bound itself', () => {
    expect(messageFor(qualifiersPerPoolSchema, QUALIFIERS_PER_POOL_MAX + 1)).toBe(
      'At most 1,000 players can advance from each pool.',
    )
    // ⚠️ The boundary is the server's, inclusive (`le=1000`) — so it must SAVE. A form
    // that refused 1,000 would refuse a save the API accepts, which is the mirror image
    // of the bug and just as wrong.
    expect(messageFor(qualifiersPerPoolSchema, QUALIFIERS_PER_POOL_MAX)).toBeUndefined()
    expect(messageFor(qualifiersPerPoolSchema, QUALIFIERS_PER_POOL_MIN)).toBeUndefined()
  })

  /** The number itself, not just the behaviour: the client's bound and the server's
   * `le=1000` are the same value stated twice, and a drift either way is a refusal one
   * layer makes and the other does not. */
  it('mirrors the server’s number exactly', () => {
    expect(QUALIFIERS_PER_POOL_MAX).toBe(1000)
  })
})

describe('the entry fee (`EventEntryFee`: required, `ge=0`, whole cents)', () => {
  it('refuses a blank fee — `NaN` is missing, and a fee is required', () => {
    // The control holds a blank fee as `NaN`, *never* as `0`: "they left it blank" and
    // "they typed zero" are two different facts, and only one of them is an error.
    expect(messageFor(entryFeeSchema, Number.NaN)).toBe('Entry fee is required.')
  })

  it('ACCEPTS a fee of zero — a free event is a real answer', () => {
    expect(messageFor(entryFeeSchema, 0)).toBeUndefined()
  })

  it('refuses a negative fee', () => {
    expect(messageFor(entryFeeSchema, -1)).toBe('The entry fee cannot be negative.')
  })

  it('refuses a fee no column could hold — the player limit’s bug, in its sibling', () => {
    // `entry_fee` is `Numeric(8, 2)`: six digits and two decimals. A fee past that
    // overflows it and 500s, exactly as `9999999999` did on the `Integer` limit — the
    // same hole, one field over, found by looking rather than by waiting for QA.
    expect(messageFor(entryFeeSchema, 9_999_999_999)).toBe(
      'The entry fee must be 999,999.99 or less.',
    )
    expect(messageFor(entryFeeSchema, ENTRY_FEE_MAX)).toBeUndefined()
  })

  /** The quieter half of the same fault: Postgres does not *refuse* a third decimal on
   * a `Numeric(8, 2)` — it silently **rounds** it. `45.005` is stored, read back and
   * charged as `45.01`, a price the organizer never typed and nothing ever reported. A
   * boundary that rewrites its input is worse than one that refuses it. */
  it('refuses a fee that is not in whole cents, rather than let the column round it', () => {
    expect(messageFor(entryFeeSchema, 45.005)).toBe(
      'An entry fee is in whole cents — at most 2 decimal places.',
    )
    // Two places is a price. (`45.10` is two places — not the binary tail of 10.1.)
    expect(messageFor(entryFeeSchema, 45.1)).toBeUndefined()
    expect(messageFor(entryFeeSchema, 12.5)).toBeUndefined()
  })
})

/**
 * A **pool's** name — the last field in this editor that could still author a 422 (#786).
 *
 * The editor mints a pool's id and its default name ("Pool A"), so the happy path could
 * never make a blank one. The box, however, is live: an emptied one was a save the form
 * allowed and the server refused, in Pydantic's words ("String should have at least 1
 * character"), in a banner naming no field.
 */
describe('poolNameSchema', () => {
  it('requires a name — in the same words the event’s own name uses', () => {
    // The same sentence, because to the organizer clearing a box it is the same news.
    expect(messageFor(poolNameSchema, '')).toBe('Name is required.')
    expect(messageFor(poolNameSchema, '   ')).toBe('Name is required.')
    expect(messageFor(poolNameSchema, 'Pool A')).toBeUndefined()
  })

  /** ⚠️ **No ceiling.** `Pool.name` is `min_length=1` with no `max_length`: a pool lives
   * in JSONB, and there is no column for it to overflow (unlike the event's
   * `VARCHAR(255)`). A bound here would be a rule the API does not have — and a save
   * refused by nothing but us. */
  it('invents no ceiling the server does not have', () => {
    expect(messageFor(poolNameSchema, 'A'.repeat(NAME_MAX + 1))).toBeUndefined()
  })
})

describe('poolNameIssues', () => {
  const pool = (id: string, name: string) => ({ id, name })

  /** Keyed by pool id, so the red lands under the box that is empty. A director with six
   * pools and one blank name must not be pointed at all six. */
  it('blames only the pool that is blank', () => {
    expect(
      poolNameIssues([pool('p-a', ''), pool('p-b', 'Pool B'), pool('p-c', '  ')]),
    ).toEqual({ 'p-a': 'Name is required.', 'p-c': 'Name is required.' })
  })

  it('says nothing about a list of named pools', () => {
    expect(poolNameIssues([pool('p-a', 'Pool A')])).toEqual({})
    expect(poolNameIssues([])).toEqual({})
  })

  /** The message is the SCHEMA's, read off it rather than re-typed beside it: the
   * resolver refuses the save and this puts the red under the box, and the two must not
   * be able to say different things about the same field. */
  it('speaks the schema’s own words', () => {
    expect(poolNameIssues([pool('p-a', '')])['p-a']).toBe(
      messageFor(poolNameSchema, ''),
    )
  })
})
