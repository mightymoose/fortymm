import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { ApiError, api, isSessionMergedError, setSessionEndedHandler } from './client'

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

it('isSessionMergedError recognizes only the structured session_merged 401', () => {
  const merged = new ApiError(401, 'gone', 'load session', {
    detail: { code: 'session_merged', message: 'gone' },
  })
  expect(isSessionMergedError(merged)).toBe(true)

  // A bare 401 (no structured code) is not the merge case.
  expect(
    isSessionMergedError(
      new ApiError(401, 'unauthorized', 'load session', {
        detail: 'authentication required',
      }),
    ),
  ).toBe(false)
  // A different code, or a non-401, or a non-ApiError, all fall through.
  expect(
    isSessionMergedError(
      new ApiError(401, null, 'x', { detail: { code: 'unauthenticated' } }),
    ),
  ).toBe(false)
  expect(
    isSessionMergedError(
      new ApiError(403, null, 'x', { detail: { code: 'session_merged' } }),
    ),
  ).toBe(false)
  expect(isSessionMergedError(new Error('boom'))).toBe(false)
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
