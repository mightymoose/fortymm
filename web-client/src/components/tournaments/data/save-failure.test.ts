import { ApiError } from '@/api/client'

import {
  EVENT_SAVE_TARGET,
  TOURNAMENT_SAVE_TARGET,
  saveFailure,
  saveFailureMessage,
  type SaveFailure,
} from './save-failure'

/** FastAPI's real 422 body for a 256-character event name — the one QA watched the
 * editor read out to the organizer, word for machine word. */
const nameTooLong = new ApiError(
  422,
  'String should have at most 255 characters',
  'update event',
  {
    detail: [
      {
        type: 'string_too_long',
        loc: ['body', 'name'],
        msg: 'String should have at most 255 characters',
      },
    ],
  },
)

/** FastAPI's real 422 body for a reservation whose name was cleared — the server's new
 * floor (`Reservation.name`, `min_length=1`). The form now refuses this save before it
 * is sent (`reservationNameSchema`), so an organizer should never meet it; a stale tab,
 * or a hand-crafted request, still can — and what comes back must not be read out to
 * them.
 *
 * ⚠️ Note the `loc`: a reservation's name is nested TWO levels down, through an array
 * INDEX (`["body", "reservations", 0, "name"]`). `validationFields` drops the
 * non-string parts and keeps the first segment after `body`, so the field it blames is
 * `reservations` — which the event's label table has a row for ("Reservations"). A 422
 * whose `loc` fell through to no label at all would be worded generically, which is a
 * worse answer than naming the tab. */
const reservationNameBlank = new ApiError(
  422,
  'String should have at least 1 character',
  'update event',
  {
    detail: [
      {
        type: 'string_too_short',
        loc: ['body', 'reservations', 0, 'name'],
        msg: 'String should have at least 1 character',
      },
    ],
  },
)

const say = (error: unknown): string =>
  saveFailureMessage(saveFailure(error), EVENT_SAVE_TARGET)

describe('saveFailure', () => {
  it('classifies a pydantic 422 by its SHAPE, and keeps only the fields', () => {
    expect(saveFailure(nameTooLong)).toEqual<SaveFailure>({
      kind: 'invalid',
      fields: ['name'],
    })
  })

  /** The blank reservation name (#786) — the schema mirrors it client-side now, but the
   * classifier is the backstop for the stale tab that does not know that yet. It is an
   * `invalid`, its `loc` resolves to the `reservations` field, and its `msg` —
   * Pydantic's "String should have at least 1 character" — is thrown away, exactly like
   * the name's. */
  it('classifies a blank RESERVATION name — through the array index in its loc', () => {
    expect(saveFailure(reservationNameBlank)).toEqual<SaveFailure>({
      kind: 'invalid',
      fields: ['reservations'],
    })
  })

  it('classifies a 4xx the server explained in a sentence as a refusal', () => {
    const forbidden = new ApiError(403, 'You can only modify tournaments you created.', 'x', {
      detail: 'You can only modify tournaments you created.',
    })
    expect(saveFailure(forbidden)).toEqual<SaveFailure>({
      kind: 'refused',
      message: 'You can only modify tournaments you created.',
    })
  })

  /**
   * THE round-three regression. A 5xx and a dead connection were ONE arm
   * (`unreachable`), so a real HTTP 500 told the organizer *"the server couldn't be
   * reached — check your connection"*. The server had been reached. It answered. The
   * two are opposite news and they are now opposite arms.
   */
  it('classifies a 5xx as a SERVER FAULT — not as a connection that failed', () => {
    expect(saveFailure(new ApiError(500, null, 'x'))).toEqual<SaveFailure>({
      kind: 'faulted',
      status: 500,
    })
    // A 502/503/504 — a proxy or a restart — is the same news, from the same evidence:
    // an answer came back.
    expect(saveFailure(new ApiError(503, null, 'x'))).toEqual<SaveFailure>({
      kind: 'faulted',
      status: 503,
    })
  })

  it('classifies a fetch that never got an answer as offline', () => {
    // What a genuine network failure actually IS, per `src/api/client.ts`: `fetch`
    // rejects, openapi-fetch RE-THROWS that rejection, and `unwrap` never runs — so it
    // arrives as the platform's own `TypeError`, and never as an `ApiError` at all. A
    // classifier that only ever looked at `ApiError.status` could not see this case,
    // which is exactly why the 500 was wearing its copy.
    expect(saveFailure(new TypeError('Failed to fetch'))).toEqual<SaveFailure>({
      kind: 'offline',
    })
    // The same failure, in each engine's words.
    expect(saveFailure(new TypeError('Load failed'))).toEqual<SaveFailure>({
      kind: 'offline',
    })
    expect(
      saveFailure(new TypeError('NetworkError when attempting to fetch resource.')),
    ).toEqual<SaveFailure>({ kind: 'offline' })
    // …and `unwrap`'s own spelling of "no response at all".
    expect(saveFailure(new ApiError(0, null, 'x'))).toEqual<SaveFailure>({
      kind: 'offline',
    })
  })

  it('does NOT read one of our own bugs as an outage', () => {
    // A `TypeError` is also what a defect of ours throws. Blaming the user's connection
    // for it would be the same lie the 500 was telling, one layer down — so an error
    // whose message is not a fetch failure stays `unknown`, which claims nothing about
    // the network.
    expect(
      saveFailure(new TypeError("Cannot read properties of undefined (reading 'id')")),
    ).toEqual<SaveFailure>({ kind: 'unknown' })
    expect(saveFailure('a string')).toEqual<SaveFailure>({ kind: 'unknown' })
  })
})

describe('saveFailureMessage', () => {
  /**
   * THE regression. The banner used to render `ApiError.detail`, which for a 422 is
   * Pydantic's own prose. `DEFINITION_OF_COMPLETE.md`: *"Raw API detail strings never
   * reach the UI."*
   */
  it('never repeats pydantic’s words back at the organizer', () => {
    const message = say(nameTooLong)
    expect(message).not.toContain('String should have at most')
    expect(message).not.toContain('String')
    expect(message).not.toContain('character')
  })

  it('names the field the server refused, in the words the form puts above it', () => {
    // `name` is the wire's; "Event name" is what the label over the box says.
    expect(say(nameTooLong)).toBe(
      'The Event name was rejected. Check that field and try again.',
    )
  })

  it('names several refused fields in one sentence', () => {
    const error = new ApiError(422, null, 'x', {
      detail: [
        { loc: ['body', 'max_players'], msg: 'Input should be a valid integer' },
        { loc: ['body', 'entry_fee'], msg: 'Input should be greater than or equal to 0' },
      ],
    })
    expect(say(error)).toBe(
      'The Player limit and Entry fee were rejected. Check those fields and try again.',
    )
  })

  it('falls back to its own generic wording for a 422 naming no field the form has', () => {
    const error = new ApiError(422, 'nope', 'x', {
      detail: [{ loc: ['body', 'seeding_policy'], msg: 'Input should be a valid string' }],
    })
    expect(say(error)).toBe(
      "Some of this event's details were rejected. Check the fields and try again.",
    )
  })

  it('says nothing about Pydantic even when the 422 carries a bare string detail', () => {
    // One of OUR `HTTPException(422, "...")`s. It is still "we sent something the
    // server won't take", and the client still owns the wording.
    const error = new ApiError(422, 'whatever the server said', 'x', {
      detail: 'whatever the server said',
    })
    expect(say(error)).toBe(
      "Some of this event's details were rejected. Check the fields and try again.",
    )
  })

  it('speaks the SERVER’s sentence only for a refusal it cannot name (ADR-0968)', () => {
    // The last-resort fallback: a 403's detail is a sentence a human wrote for a
    // human. Better than inventing a headline for a refusal we do not model.
    const error = new ApiError(403, 'You can only modify tournaments you created.', 'x', {
      detail: 'You can only modify tournaments you created.',
    })
    expect(say(error)).toBe('You can only modify tournaments you created.')
  })

  /**
   * The copy half of the same regression, and the one QA actually read off the screen:
   * *"The server couldn't be reached. Check your connection and try again."* — on a 500.
   * It is false, and it is expensively false: it sends someone to go and look at their
   * router over a fault in our own process.
   */
  it('never blames the CONNECTION for a fault the server reported', () => {
    const message = say(new ApiError(500, 'Internal Server Error', 'x'))

    expect(message).not.toContain('connection')
    expect(message).not.toContain('reached')
    // Ours, and honest about whose fault it is.
    expect(message).toBe(
      'Something went wrong on our end. Nothing you did caused it — try again in a moment.',
    )
    // …and the server's own 500 prose ("Internal Server Error") is not copy either.
    expect(message).not.toContain('Internal Server Error')
  })

  it('blames the connection ONLY when no response ever arrived', () => {
    expect(say(new TypeError('Failed to fetch'))).toBe(
      "The server couldn't be reached. Check your connection and try again.",
    )
  })

  it('says something plain — never nothing — for a failure it cannot classify', () => {
    expect(say(new TypeError('boom'))).toBe('Something went wrong. Try again.')
  })
})

/**
 * The second caller: the "New tournament" dialog. These exist to hold the
 * generalisation honest — the sentences below come out of the SAME table as the event
 * editor's above, and the only thing that changed is the *data* the form brought (its
 * noun, and the labels it prints over its rows). A second copy table would pass these
 * too, and would then drift, which is the failure ADR-0968 is about.
 */
describe('saveFailureMessage · a reservation the server refused', () => {
  /** In OUR words, naming the tab the reservation is on — never the wire's. */
  it('names the Reservations tab, and never says “String”', () => {
    const message = say(reservationNameBlank)
    expect(message).toContain('Reservations')
    expect(message).not.toContain('String')
    expect(message).not.toContain('at least 1 character')
  })
})

describe('saveFailureMessage · the tournament dialog', () => {
  const sayTournament = (error: unknown): string =>
    saveFailureMessage(saveFailure(error), TOURNAMENT_SAVE_TARGET)

  it('never repeats pydantic’s words back, and names the field in the dialog’s own', () => {
    // The same wire body the event editor gets — `TournamentCreate.name` is also
    // `VARCHAR(255)`, so it is the same 422. Same classifier, this form's label.
    const message = sayTournament(nameTooLong)
    expect(message).not.toContain('String')
    expect(message).not.toContain('character')
    expect(message).toBe('The Name was rejected. Check that field and try again.')
  })

  it('points at the venue address when the server blames a nested address field', () => {
    // `loc: ["body", "address", "postal"]` — the leaf is the wire's business, so the
    // sentence names the block of the form the organizer can actually go and look at.
    const error = new ApiError(422, 'Input should be a valid string', 'create tournament', {
      detail: [
        { loc: ['body', 'address', 'postal'], msg: 'Input should be a valid string' },
      ],
    })
    expect(sayTournament(error)).toBe(
      'The Venue address was rejected. Check that field and try again.',
    )
  })

  it('uses the tournament’s noun in the generic wording, not the event’s', () => {
    const error = new ApiError(422, 'nope', 'create tournament', {
      detail: [{ loc: ['body', 'league_id'], msg: 'Input should be a valid uuid' }],
    })
    expect(sayTournament(error)).toBe(
      "Some of this tournament's details were rejected. Check the fields and try again.",
    )
  })

  it('speaks the server’s sentence for a refusal it cannot name (a 409)', () => {
    const error = new ApiError(409, 'You already run a tournament by that name.', 'x', {
      detail: 'You already run a tournament by that name.',
    })
    expect(sayTournament(error)).toBe('You already run a tournament by that name.')
  })
})
