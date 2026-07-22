import { buildEvent, buildPool, buildPredicate } from '../data/seed.factory'
import {
  eventSchema,
  eventToFormValues,
  firstInvalidSection,
  type EventFormValues,
} from './event-form'

/** Which *fields* the one resolver rejected — the set the editor's tab routing and
 * the Basics section's red both read. Keyed, because "it failed" is not an assertion:
 * the whole point of the schema is which field it blames. */
function rejectedFields(values: EventFormValues): string[] {
  const result = eventSchema.safeParse(values)
  if (result.success) return []
  return [...new Set(result.error.issues.map((i) => String(i.path[0])))]
}

const formFor = (overrides: Parameters<typeof buildEvent>[0] = {}) =>
  eventToFormValues(buildEvent(overrides))

describe('eventSchema', () => {
  it('accepts the seeded event whole', () => {
    expect(rejectedFields(formFor())).toEqual([])
  })

  /**
   * ⚠️ **The uncapped event, at the resolver.** A blank player limit is `null`, and
   * `null` is a saveable event with no cap (ADR-0935) — so the schema that gates the
   * submit must *accept* it. A "required" rule here would un-ship the whole feature,
   * and it would do it quietly: the Save button would simply stop working.
   */
  it('accepts an event with NO player cap, and still refuses a cap of zero', () => {
    expect(rejectedFields(formFor({ maxPlayers: null }))).toEqual([])
    expect(rejectedFields(formFor({ maxPlayers: 0 }))).toEqual(['maxPlayers'])
  })

  it('requires an entry fee, and takes zero for a free event', () => {
    expect(rejectedFields(formFor({ entryFee: Number.NaN }))).toEqual(['entryFee'])
    expect(rejectedFields(formFor({ entryFee: 0 }))).toEqual([])
  })

  it('refuses a name the column cannot hold', () => {
    expect(rejectedFields(formFor({ name: '' }))).toEqual(['name'])
    expect(rejectedFields(formFor({ name: 'A'.repeat(256) }))).toEqual(['name'])
  })

  /** The rules are the one guard with no server-side twin: the API accepts a
   * half-written rule (`Rating < ?`), and the client must not — so the resolver refuses
   * to *send* one. The row-level message is `eligibilityIssues`' job; what is asserted
   * here is that the form will not go out at all. */
  it('refuses a rule the server could evaluate but no player could satisfy', () => {
    expect(
      rejectedFields(formFor({ predicates: [buildPredicate({ op: '<', value: null })] })),
    ).toEqual(['predicates'])
    expect(
      rejectedFields(
        formFor({ predicates: [buildPredicate({ op: 'between', value: [1600, 1200] })] }),
      ),
    ).toEqual(['predicates'])
    expect(
      rejectedFields(formFor({ predicates: [buildPredicate({ op: '<', value: 1500 })] })),
    ).toEqual([])
  })

  /** A pool is *called* something — the server says so (`Pool.name`, `min_length=1`),
   * and so, now, does the resolver. The editor mints the id and the default name, so
   * the only way to author a blank one is to clear the box; this is what stops the
   * result being sent. */
  it('refuses a pool with no name — blank, or a space', () => {
    expect(rejectedFields(formFor({ pools: [buildPool({ name: '' })] }))).toEqual([
      'pools',
    ])
    expect(rejectedFields(formFor({ pools: [buildPool({ name: '   ' })] }))).toEqual([
      'pools',
    ])
    expect(rejectedFields(formFor({ pools: [buildPool({ name: 'Pool A' })] }))).toEqual(
      [],
    )
  })

  /** ⚠️ No ceiling: `Pool.name` has `min_length=1` and **no** `max_length` (a pool lives
   * in JSONB — there is no column to overflow, unlike the event's `VARCHAR(255)`).
   * Mirroring a bound the API does not have would refuse a save nothing on the server
   * would ever have refused. */
  it('does NOT invent a ceiling the server has no column for', () => {
    expect(
      rejectedFields(formFor({ pools: [buildPool({ name: 'A'.repeat(300) })] })),
    ).toEqual([])
  })

  /** The name that is *sent* is the name that was judged: trimmed, so the server's
   * `min_length` counts the same characters this schema did. */
  it('trims the pool name it lets through', () => {
    const parsed = eventSchema.parse(
      formFor({ pools: [buildPool({ name: '  Championship  ' })] }),
    )
    expect(parsed.pools[0].name).toBe('Championship')
  })

  /** The timezone anchors the windows and is `NOT NULL` on the server (ADR 20260719),
   * so the resolver mirrors it: a real zone passes, a cleared one is refused before
   * the save leaves the room. (Whether it names a *known* zone is the server's to
   * judge — an unknown one is a 422 — so the client rule is only "non-empty".) */
  it('requires a non-empty timezone', () => {
    expect(rejectedFields(formFor({ timezone: 'America/Chicago' }))).toEqual([])
    expect(rejectedFields(formFor({ timezone: '' }))).toEqual(['timezone'])
    expect(rejectedFields(formFor({ timezone: '   ' }))).toEqual(['timezone'])
  })
})

describe('eventToFormValues', () => {
  it('carries a null cap through as null — never as a number', () => {
    expect(eventToFormValues(buildEvent({ maxPlayers: null })).maxPlayers).toBeNull()
  })

  it("projects the event's timezone onto the form", () => {
    expect(eventToFormValues(buildEvent({ timezone: 'Europe/Paris' })).timezone).toBe(
      'Europe/Paris',
    )
  })

  /** A brand-new event (no `event` at all) starts **uncapped**, not at an invented
   * number, and with no fee rather than a free one. */
  it('starts a brand-new event uncapped, with the fee unanswered', () => {
    const values = eventToFormValues(null)
    expect(values.maxPlayers).toBeNull()
    expect(values.entryFee).toBeNaN()
  })
})

describe('firstInvalidSection', () => {
  it('sends a broken name to Basics', () => {
    expect(firstInvalidSection({ name: { type: 'custom', message: 'x' } })).toBe(
      'basics',
    )
  })

  it('sends a broken player limit to Basics', () => {
    expect(firstInvalidSection({ maxPlayers: { type: 'custom', message: 'x' } })).toBe(
      'basics',
    )
  })

  it('sends a broken timezone to Basics', () => {
    expect(firstInvalidSection({ timezone: { type: 'custom', message: 'x' } })).toBe(
      'basics',
    )
  })

  it('sends a broken rule to Eligibility', () => {
    expect(
      firstInvalidSection({ predicates: { type: 'custom', message: 'x' } }),
    ).toBe('eligibility')
  })

  it('sends a broken pool name to Table pools', () => {
    expect(firstInvalidSection({ pools: { type: 'custom', message: 'x' } })).toBe(
      'pools',
    )
  })

  // With both broken, the name is the field they are most likely to have simply not
  // filled in — landing on the *later* tab would leave it behind them, unseen.
  it('sends a form broken in BOTH places to Basics — the tab they’d otherwise never see', () => {
    expect(
      firstInvalidSection({
        name: { type: 'custom', message: 'x' },
        predicates: { type: 'custom', message: 'x' },
      }),
    ).toBe('basics')
  })

  it('sends a clean form nowhere', () => {
    expect(firstInvalidSection({})).toBeNull()
  })
})
