import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'

import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { api, setSessionEndedHandler } from './client'

afterEach(() => setSessionEndedHandler(null))

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
