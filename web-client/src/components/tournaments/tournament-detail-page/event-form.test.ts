import { buildEvent, buildPredicate } from '../data/seed.factory'
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
})

describe('eventToFormValues', () => {
  it('carries a null cap through as null — never as a number', () => {
    expect(eventToFormValues(buildEvent({ maxPlayers: null })).maxPlayers).toBeNull()
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

  it('sends a broken rule to Eligibility', () => {
    expect(
      firstInvalidSection({ predicates: { type: 'custom', message: 'x' } }),
    ).toBe('eligibility')
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
