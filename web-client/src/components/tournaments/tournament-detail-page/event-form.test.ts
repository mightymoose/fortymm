import { buildEvent, buildReservation, buildPredicate } from '../data/seed.factory'
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

  /**
   * **K is judged with its draw type, never alone** (ADR 20260727) — the resolver's half
   * of the server's tagged union.
   *
   * The pair is the whole design. A field-level rule would have to answer "is a null
   * qualifier count wrong?" without knowing the draw type, and both answers are wrong
   * half the time: for `rr-then-ko`, `null` is a missing answer; for the other two it is
   * the only legal value — and a red raised there would refuse the save with a message
   * under a control that is not even rendered.
   */
  describe('the qualifier count', () => {
    const twoStage = (qualifiersPerGroup: number | null) =>
      formFor({ drawType: 'rr-then-ko', qualifiersPerGroup })

    it('requires a count for rr-then-ko, and blames the field by name', () => {
      expect(rejectedFields(twoStage(null))).toEqual(['qualifiersPerGroup'])
    })

    // `ge=1` on the server (`QualifiersPerGroup`). Zero advances nobody into the
    // knockout stage, and a negative count is not a count.
    it.each([0, -1, 1.5])('refuses %s', (bad) => {
      expect(rejectedFields(twoStage(bad))).toEqual(['qualifiersPerGroup'])
    })

    it('accepts the smallest legal count, and a larger one', () => {
      expect(rejectedFields(twoStage(1))).toEqual([])
      expect(rejectedFields(twoStage(4))).toEqual([])
    })

    /**
     * ⚠️ **`le=1000` on the server, and the resolver has to know it too** (#1231 QA).
     * `2147483648` overflows the `Integer` column and came back a 500; `999999999` was
     * accepted and made an event nobody could draw. Both are refused HERE now, so
     * neither is ever sent — and the message names the number, since the number is the
     * only thing the director can change.
     */
    it.each([1001, 999_999_999, 2_147_483_648])('refuses %s', (tooMany) => {
      expect(rejectedFields(twoStage(tooMany))).toEqual(['qualifiersPerGroup'])
    })

    it('speaks the schema’s own sentence about the ceiling', () => {
      const result = eventSchema.safeParse(twoStage(1001))
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toBe(
        'At most 1,000 players can advance from each group.',
      )
    })

    // The server's bound is INCLUSIVE, so the boundary itself must save — a form that
    // refused 1,000 would refuse a save the API accepts.
    it('accepts the ceiling itself', () => {
      expect(rejectedFields(twoStage(1000))).toEqual([])
    })

    // ⚠️ The inverse, and the one a field-level rule would get wrong: a round-robin
    // event carries `null` and must SAVE. A schema that demanded a count regardless
    // would dead-end every single-stage event, with a red nobody could see or fix.
    it.each(['round-robin', 'single-elim'] as const)(
      'asks nothing of %s, whose count is null',
      (drawType) => {
        expect(rejectedFields(formFor({ drawType, qualifiersPerGroup: null }))).toEqual([])
      },
    )

    // …and does not complain about a STALE count left behind by a draw-type switch:
    // the control unmounted, but React-Hook-Form keeps the value, and the write body
    // omits it anyway (`eventToApiFields`). A rule that fired here would block the save
    // over a number that is never sent.
    it('ignores a leftover count once the draw type no longer has a knockout stage', () => {
      expect(
        rejectedFields(formFor({ drawType: 'round-robin', qualifiersPerGroup: 2 })),
      ).toEqual([])
    })
  })

  /**
   * **R is judged with its draw type, never alone** (ADR "swiss pre-cuts every round and
   * pairs each one on advance") — the resolver's half of the server's tagged union, one
   * draw type over from the qualifier count above and for the identical reason.
   *
   * A field-level rule would have to answer "is a null round count wrong?" without knowing
   * the draw type, and both answers are wrong three-quarters of the time: for `swiss`,
   * `null` is a missing answer; for the other three it is the only legal value — and a red
   * raised there would refuse the save with a message under a control that is not rendered.
   */
  describe('the round count', () => {
    const swiss = (rounds: number | null) => formFor({ drawType: 'swiss', rounds })

    it('requires a round count for swiss, and blames the field by name', () => {
      expect(rejectedFields(swiss(null))).toEqual(['rounds'])
    })

    it('speaks the schema’s own sentence about the missing answer', () => {
      const result = eventSchema.safeParse(swiss(null))
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toBe(
        'Say how many rounds this event plays.',
      )
    })

    // `ge=1` on the server (`SwissRounds`). A swiss of zero rounds plays nothing, a
    // negative count is not a count, and half a round is not a round.
    it.each([0, -1, 2.5])('refuses %s', (bad) => {
      expect(rejectedFields(swiss(bad))).toEqual(['rounds'])
    })

    it('accepts the smallest legal count, and a larger one', () => {
      expect(rejectedFields(swiss(1))).toEqual([])
      expect(rejectedFields(swiss(5))).toEqual([])
    })

    /**
     * ⚠️ **`le=32` on the server, and the resolver has to know it too** — the qualifier
     * count's #1231 bug, one field over: an unbounded box sends a number that overflows the
     * `Integer` column, and the director is told "something went wrong on our end", which is
     * false. Refused HERE, so it is never sent, with the ceiling named because the number is
     * the only thing they can change.
     */
    it.each([33, 999_999_999, 2_147_483_648])('refuses %s', (tooMany) => {
      expect(rejectedFields(swiss(tooMany))).toEqual(['rounds'])
    })

    it('speaks the schema’s own sentence about the ceiling', () => {
      const result = eventSchema.safeParse(swiss(33))
      expect(result.success).toBe(false)
      expect(result.error?.issues[0].message).toBe(
        'A Swiss event plays at most 32 rounds.',
      )
    })

    // The server's bound is INCLUSIVE, so the boundary itself must save — a form that
    // refused 32 would refuse a save the API accepts.
    it('accepts the ceiling itself', () => {
      expect(rejectedFields(swiss(32))).toEqual([])
    })

    // ⚠️ The inverse, and the one a field-level rule would get wrong: the other three draw
    // types carry `null` and must SAVE. A schema that demanded a round count regardless
    // would dead-end every non-swiss event, with a red nobody could see or fix.
    it.each(['round-robin', 'single-elim'] as const)(
      'asks nothing of %s, whose round count is null',
      (drawType) => {
        expect(rejectedFields(formFor({ drawType, rounds: null }))).toEqual([])
      },
    )

    // …and does not complain about a STALE count left behind by a draw-type switch: the
    // control unmounted, but React-Hook-Form keeps the value, and the write body omits it
    // anyway (`drawSettingsToApi`). A rule that fired here would block the save over a
    // number that is never sent.
    it('ignores a leftover round count once the draw type no longer plays rounds', () => {
      expect(rejectedFields(formFor({ drawType: 'round-robin', rounds: 5 }))).toEqual(
        [],
      )
    })

    // The two halves of the draw configuration are judged INDEPENDENTLY: a swiss event is
    // never asked for a qualifier count, and a two-stage event is never asked for a round
    // count. A refinement that shared one branch would blame both fields at once.
    it('asks a swiss event for no qualifier count, and a two-stage one for no rounds', () => {
      expect(
        rejectedFields(
          formFor({ drawType: 'swiss', rounds: 3, qualifiersPerGroup: null }),
        ),
      ).toEqual([])
      expect(
        rejectedFields(
          formFor({ drawType: 'rr-then-ko', qualifiersPerGroup: 2, rounds: null }),
        ),
      ).toEqual([])
    })
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

  /** A reservation is *called* something — the server says so (`Reservation.name`,
   * `min_length=1`), and so, now, does the resolver. The editor mints the id and the
   * default name, so the only way to author a blank one is to clear the box; this is
   * what stops the result being sent. */
  it('refuses a reservation with no name — blank, or a space', () => {
    expect(
      rejectedFields(formFor({ reservations: [buildReservation({ name: '' })] })),
    ).toEqual(['reservations'])
    expect(
      rejectedFields(formFor({ reservations: [buildReservation({ name: '   ' })] })),
    ).toEqual(['reservations'])
    expect(
      rejectedFields(
        formFor({ reservations: [buildReservation({ name: 'Reservation A' })] }),
      ),
    ).toEqual([])
  })

  /** ⚠️ No ceiling: `Reservation.name` has `min_length=1` and **no** `max_length` (a
   * reservation lives in JSONB — there is no column to overflow, unlike the event's
   * `VARCHAR(255)`). Mirroring a bound the API does not have would refuse a save
   * nothing on the server would ever have refused. */
  it('does NOT invent a ceiling the server has no column for', () => {
    expect(
      rejectedFields(
        formFor({ reservations: [buildReservation({ name: 'A'.repeat(300) })] }),
      ),
    ).toEqual([])
  })

  /** The name that is *sent* is the name that was judged: trimmed, so the server's
   * `min_length` counts the same characters this schema did. */
  it('trims the reservation name it lets through', () => {
    const parsed = eventSchema.parse(
      formFor({ reservations: [buildReservation({ name: '  Championship  ' })] }),
    )
    expect(parsed.reservations[0].name).toBe('Championship')
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

  // It lives on Basics, beside the draw type that decides whether it is asked at all —
  // and a save refused on a tab you cannot see is indistinguishable from a dead button.
  it('sends a broken qualifier count to Basics', () => {
    expect(
      firstInvalidSection({ qualifiersPerGroup: { type: 'custom', message: 'x' } }),
    ).toBe('basics')
  })

  // …and the round count, which lives on the same tab beside the same picker.
  it('sends a broken round count to Basics', () => {
    expect(firstInvalidSection({ rounds: { type: 'custom', message: 'x' } })).toBe(
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

  it('sends a broken reservation name to Reservations', () => {
    expect(
      firstInvalidSection({ reservations: { type: 'custom', message: 'x' } }),
    ).toBe('reservations')
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
