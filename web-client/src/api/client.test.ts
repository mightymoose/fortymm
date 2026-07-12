import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import {
  ApiError,
  api,
  extractDetail,
  isSessionEndedError,
  setSessionEndedHandler,
  validationFields,
} from './client'

afterEach(() => {
  setSessionEndedHandler(null)
  // Drop any csrf cookie a test set so it can't leak into the next one.
  document.cookie = 'csrf_token=; max-age=0; path=/'
})

/** Force the middleware's internal latch back to "not firing" via a 200. */
async function resetLatch() {
  server.use(
    http.get('*/v1/session', () => HttpResponse.json(sessionResponse()), {
      once: true,
    }),
  )
  await api.GET('/v1/session')
}

function merged401(detail: Record<string, unknown>) {
  server.use(
    http.get('*/v1/session', () =>
      HttpResponse.json({ detail }, { status: 401 }),
    ),
  )
}

it('fires the session-ended handler on a session_merged 401', async () => {
  await resetLatch()
  const handler = vi.fn()
  setSessionEndedHandler(handler)

  merged401({
    code: 'session_merged',
    message: 'Merged away. Sign in.',
    email: 'owner@example.com',
  })
  await api.GET('/v1/session')

  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith({
    message: 'Merged away. Sign in.',
    email: 'owner@example.com',
  })
})

it('fires the session-ended handler on a session_ended 401 (no email)', async () => {
  await resetLatch()
  const handler = vi.fn()
  setSessionEndedHandler(handler)

  merged401({
    code: 'session_ended',
    message: "You've been signed out. Sign in to continue.",
  })
  await api.GET('/v1/session')

  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith({
    message: "You've been signed out. Sign in to continue.",
    email: undefined,
  })
})

it('ignores an ordinary (non-structured) 401', async () => {
  await resetLatch()
  const handler = vi.fn()
  setSessionEndedHandler(handler)

  merged401({ code: 'unauthenticated' }) // not session_merged
  await api.GET('/v1/session')
  server.use(
    http.get('*/v1/players/search', () =>
      HttpResponse.json({ detail: 'authentication required' }, { status: 401 }),
    ),
  )
  await api.GET('/v1/players/search', { params: { query: { q: 'x' } } })

  expect(handler).not.toHaveBeenCalled()
})

it('latches so a burst of 401s redirects only once', async () => {
  await resetLatch()
  const handler = vi.fn()
  setSessionEndedHandler(handler)

  merged401({ code: 'session_merged', message: 'm' })
  await api.GET('/v1/session')
  await api.GET('/v1/session')

  expect(handler).toHaveBeenCalledTimes(1)
})

it('isSessionEndedError recognizes both structured session-ended 401 codes', () => {
  const merged = new ApiError(401, 'gone', 'load session', {
    detail: { code: 'session_merged', message: 'gone' },
  })
  expect(isSessionEndedError(merged)).toBe(true)

  const ended = new ApiError(401, 'gone', 'save score', {
    detail: { code: 'session_ended', message: 'signed out' },
  })
  expect(isSessionEndedError(ended)).toBe(true)

  // A bare 401 (no structured code) is an ordinary auth failure.
  expect(
    isSessionEndedError(
      new ApiError(401, 'unauthorized', 'load session', {
        detail: 'authentication required',
      }),
    ),
  ).toBe(false)
  // A different code, or a non-401, or a non-ApiError, all fall through.
  expect(
    isSessionEndedError(
      new ApiError(401, null, 'x', { detail: { code: 'unauthenticated' } }),
    ),
  ).toBe(false)
  expect(
    isSessionEndedError(
      new ApiError(403, null, 'x', { detail: { code: 'session_ended' } }),
    ),
  ).toBe(false)
  expect(isSessionEndedError(new Error('boom'))).toBe(false)
})

it('echoes the csrf cookie in the X-CSRF-Token header on a mutation', async () => {
  document.cookie = 'csrf_token=tok-123; path=/'
  let seen: string | null = 'unset'
  server.use(
    http.delete('*/v1/session', ({ request }) => {
      seen = request.headers.get('X-CSRF-Token')
      return new HttpResponse(null, { status: 204 })
    }),
  )

  await api.DELETE('/v1/session')

  expect(seen).toBe('tok-123')
})

it('does not attach the csrf header on safe (GET) requests', async () => {
  document.cookie = 'csrf_token=tok-123; path=/'
  let seen: string | null = 'unset'
  server.use(
    http.get('*/v1/session', ({ request }) => {
      seen = request.headers.get('X-CSRF-Token')
      return HttpResponse.json(sessionResponse())
    }),
  )

  await api.GET('/v1/session')

  expect(seen).toBeNull()
})

it('attaches no header when there is no csrf cookie', async () => {
  let seen: string | null = 'unset'
  server.use(
    http.delete('*/v1/session', ({ request }) => {
      seen = request.headers.get('X-CSRF-Token')
      return new HttpResponse(null, { status: 204 })
    }),
  )

  await api.DELETE('/v1/session')

  expect(seen).toBeNull()
})

it('strips the pydantic "Value error, " prefix from a 422 validation message', () => {
  // FastAPI surfaces a custom validator's ValueError as a detail[] entry whose
  // msg carries pydantic's "Value error, " prefix — internal, not user copy (#151).
  expect(
    extractDetail({
      detail: [
        {
          type: 'value_error',
          loc: ['body', 'side_1_points'],
          msg: 'Value error, At 10–10 the game enters deuce; the winner must lead by 2. 11–10 is not a legal final score.',
        },
      ],
    }),
  ).toBe(
    'At 10–10 the game enters deuce; the winner must lead by 2. 11–10 is not a legal final score.',
  )
})

it('leaves a validation message without the prefix untouched', () => {
  expect(
    extractDetail({ detail: [{ msg: 'The winning side must reach at least 11 points.' }] }),
  ).toBe('The winning side must reach at least 11 points.')
})

/**
 * `validationFields` answers the question `extractDetail` cannot: **whose words are
 * these?** A `detail` ARRAY is Pydantic's — its `msg` is machine prose ("String
 * should have at most 255 characters") that must never reach a user
 * (`DEFINITION_OF_COMPLETE.md`) — while a `detail` STRING is a sentence we wrote and
 * may show. So the return is `string[] | null`, and `null` is not "no fields", it is
 * "not a validation body at all".
 */
it('names the fields a pydantic 422 blamed, stripping the `body` prefix', () => {
  const error = new ApiError(422, 'String should have at most 255 characters', 'x', {
    detail: [
      { type: 'string_too_long', loc: ['body', 'name'], msg: 'String should have at most 255 characters' },
      { type: 'int_type', loc: ['body', 'max_players'], msg: 'Input should be a valid integer' },
    ],
  })
  expect(validationFields(error)).toEqual(['name', 'max_players'])
})

it('reduces a nested loc to the field a form has a row for', () => {
  // `['body', 'slot', 'start']` is a complaint about the Time slot as far as the
  // form is concerned; the leaf is the wire's business.
  const error = new ApiError(422, null, 'x', {
    detail: [{ loc: ['body', 'slot', 'start'], msg: 'Input should be a valid string' }],
  })
  expect(validationFields(error)).toEqual(['slot'])
})

it('dedupes two complaints about the same field', () => {
  const error = new ApiError(422, null, 'x', {
    detail: [
      { loc: ['body', 'name'], msg: 'String should have at least 1 character' },
      { loc: ['body', 'name'], msg: 'String should have at most 255 characters' },
    ],
  })
  expect(validationFields(error)).toEqual(['name'])
})

it('returns null — not [] — for a refusal the server wrote in words', () => {
  // The distinction the banner turns on: a 403's `detail` is OUR sentence and may be
  // shown; a 422's `detail[]` is Pydantic's and may not.
  const prose = new ApiError(403, 'You can only modify tournaments you created.', 'x', {
    detail: 'You can only modify tournaments you created.',
  })
  expect(validationFields(prose)).toBeNull()

  const coded = new ApiError(409, 'This event is full.', 'x', {
    detail: { code: 'event_full', message: 'This event is full.' },
  })
  expect(validationFields(coded)).toBeNull()

  expect(validationFields(new ApiError(500, null, 'x'))).toBeNull()
  expect(validationFields(new Error('offline'))).toBeNull()
})
