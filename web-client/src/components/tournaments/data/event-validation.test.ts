import {
  ENTRY_FEE_MAX,
  eventIssues,
  firstInvalidSection,
  isSaveable,
  NAME_MAX,
  PLAYERS_MAX,
} from './event-validation'
import { buildEvent, buildPredicate } from './seed.factory'

/** Longer than `tournament_events.name` (`VARCHAR(255)`) — the 422 the organizer used
 * to meet only *after* the request had gone, in Pydantic's words. */
const TOO_LONG = 'A'.repeat(NAME_MAX + 1)

/** A cleared number box, exactly as the control produces it: `BasicsSection` sets
 * `Number(e.target.value)`, and **`Number('')` is `0`** — not `NaN`, which is the trap
 * in this field. So an emptied player limit is a *zero-player event*, which the server
 * refuses (`max_players: int = Field(gt=0)`) with the 422 nobody had ever seen the
 * form catch. */
const CLEARED = Number('')

/** …and the value the field holds when it holds no number at all (a `NaN` from any
 * other route into the draft). It is *nothing*, not a small number. */
const NOT_A_NUMBER = Number.NaN

describe('eventIssues', () => {
  it('finds nothing wrong with the seeded event', () => {
    const issues = eventIssues(buildEvent())
    expect(issues).toEqual({ basics: {}, rules: {} })
    expect(isSaveable(issues)).toBe(true)
    expect(firstInvalidSection(issues)).toBeNull()
  })

  describe('the event name (#783 QA — the field with no guard at all)', () => {
    it('refuses a blank name, in the sibling dialog’s words', () => {
      // `NewTournamentModal` says exactly this of the tournament's name. It is the
      // same field to the person typing it; two wordings would be two rules.
      expect(eventIssues(buildEvent({ name: '' })).basics.name).toBe('Name is required.')
    })

    it('refuses a name that is only whitespace', () => {
      // The server trims nothing — `"   "` is 3 characters and passes `min_length=1`
      // — but an event called three spaces is not a named event.
      expect(eventIssues(buildEvent({ name: '   ' })).basics.name).toBe(
        'Name is required.',
      )
    })

    it('refuses a name past the column’s 255 characters', () => {
      expect(eventIssues(buildEvent({ name: TOO_LONG })).basics.name).toBe(
        'Name must be 255 characters or fewer.',
      )
    })

    it('accepts a name of exactly 255 — the boundary the server accepts', () => {
      expect(eventIssues(buildEvent({ name: 'A'.repeat(NAME_MAX) })).basics.name).toBeUndefined()
    })
  })

  describe('the player limit (`max_players: int = Field(gt=0)`)', () => {
    it('refuses a cleared box — an event of zero players is a 422', () => {
      expect(eventIssues(buildEvent({ maxPlayers: CLEARED })).basics.maxPlayers).toBe(
        'The player limit must be at least 1.',
      )
    })

    it('refuses a fraction of a player', () => {
      expect(eventIssues(buildEvent({ maxPlayers: 12.5 })).basics.maxPlayers).toBe(
        'The player limit must be a whole number.',
      )
    })

    it('refuses a value that is not a number, as EMPTY rather than as small', () => {
      // `NaN` is what the box is showing: nothing. It must not fall through the type
      // check and be reported as a *bound* violation ("at least 1"), which is what a
      // schema trusting `z.number()` to reject `NaN` does under the ESM build.
      expect(
        eventIssues(buildEvent({ maxPlayers: NOT_A_NUMBER })).basics.maxPlayers,
      ).toBe('Enter a player limit.')
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
      expect(
        eventIssues(buildEvent({ maxPlayers: 9_999_999_999 })).basics.maxPlayers,
      ).toBe('The player limit must be 512 or fewer.')
    })

    it('refuses one player past the bound, and accepts the bound itself', () => {
      expect(
        eventIssues(buildEvent({ maxPlayers: PLAYERS_MAX + 1 })).basics.maxPlayers,
      ).toBe('The player limit must be 512 or fewer.')
      // The boundary is a real answer: a 512-player draw is nine rounds of single
      // elimination, and an event that big must still save.
      expect(
        eventIssues(buildEvent({ maxPlayers: PLAYERS_MAX })).basics.maxPlayers,
      ).toBeUndefined()
    })
  })

  describe('the entry fee (`entry_fee: float = Field(ge=0)`)', () => {
    it('refuses a negative fee', () => {
      expect(eventIssues(buildEvent({ entryFee: -1 })).basics.entryFee).toBe(
        'The entry fee cannot be negative.',
      )
    })

    it('refuses a value that is not a number', () => {
      expect(eventIssues(buildEvent({ entryFee: NOT_A_NUMBER })).basics.entryFee).toBe(
        'Enter an entry fee (0 for a free event).',
      )
    })

    it('accepts a free event — a cleared box IS zero here, and zero is a real answer', () => {
      // The one place `Number('') === 0` is not a bug: `entry_fee: float = Field(ge=0)`
      // accepts it, and a free event is a thing organizers run.
      expect(eventIssues(buildEvent({ entryFee: CLEARED })).basics.entryFee).toBeUndefined()
      expect(eventIssues(buildEvent({ entryFee: 12.5 })).basics.entryFee).toBeUndefined()
    })

    it('refuses a fee no column could hold — the player limit’s bug, in its sibling', () => {
      // `entry_fee` is `Numeric(8, 2)`: six digits and two decimals. A fee past that
      // overflows it and 500s, exactly as `9999999999` did on the `Integer` limit — the
      // same hole, one field over, found by looking rather than by waiting for QA.
      expect(
        eventIssues(buildEvent({ entryFee: 9_999_999_999 })).basics.entryFee,
      ).toBe('The entry fee must be 999,999.99 or less.')
      expect(
        eventIssues(buildEvent({ entryFee: ENTRY_FEE_MAX })).basics.entryFee,
      ).toBeUndefined()
    })
  })

  it('still carries the rules’ own verdict, by predicate id', () => {
    const predicate = buildPredicate({ id: 'pr-1', op: '<', value: null })
    const issues = eventIssues(buildEvent({ predicates: [predicate] }))
    expect(issues.rules).toEqual({ 'pr-1': { value: 'Enter a rating.' } })
    expect(isSaveable(issues)).toBe(false)
  })
})

describe('firstInvalidSection', () => {
  it('sends a broken name to Basics', () => {
    expect(firstInvalidSection(eventIssues(buildEvent({ name: '' })))).toBe('basics')
  })

  it('sends a broken rule to Eligibility', () => {
    const event = buildEvent({ predicates: [buildPredicate({ op: '<', value: null })] })
    expect(firstInvalidSection(eventIssues(event))).toBe('eligibility')
  })

  it('sends a draft broken in BOTH places to Basics — the tab they’d otherwise never see', () => {
    const event = buildEvent({
      name: '',
      predicates: [buildPredicate({ op: '<', value: null })],
    })
    expect(firstInvalidSection(eventIssues(event))).toBe('basics')
  })
})
