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

const say = (error: unknown): string =>
  saveFailureMessage(saveFailure(error), EVENT_SAVE_TARGET)

describe('saveFailure', () => {
  it('classifies a pydantic 422 by its SHAPE, and keeps only the fields', () => {
    expect(saveFailure(nameTooLong)).toEqual<SaveFailure>({
      kind: 'invalid',
      fields: ['name'],
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

  it('classifies a 5xx and a dead connection as unreachable', () => {
    expect(saveFailure(new ApiError(500, null, 'x'))).toEqual<SaveFailure>({
      kind: 'unreachable',
    })
    // status 0 is `unwrap`'s "no response at all".
    expect(saveFailure(new ApiError(0, null, 'x'))).toEqual<SaveFailure>({
      kind: 'unreachable',
    })
  })

  it('classifies anything that is not an ApiError as unknown', () => {
    expect(saveFailure(new TypeError('boom'))).toEqual<SaveFailure>({ kind: 'unknown' })
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

  it('speaks plainly about a failure that is not about the event', () => {
    expect(say(new ApiError(500, null, 'x'))).toBe(
      "The server couldn't be reached. Check your connection and try again.",
    )
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
