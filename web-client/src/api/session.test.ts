import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { server } from '@/mocks/server'
import { closeRealtimeConnections } from './realtime/connection'
import {
  SESSION_QUERY_KEY,
  readStorageLock,
  useConfirmEmail,
  useConsumeLoginToken,
  useLoginSender,
  useLogout,
} from './session'

// Stubbed wholesale: these tests are about WHEN the stream is closed relative
// to the cache being cleared, and a real connection would need a real stream.
vi.mock('./realtime/connection', () => ({
  closeRealtimeConnections: vi.fn(),
}))

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.mocked(closeRealtimeConnections).mockReset()
})

afterEach(() => {
  queryClient.clear()
  vi.restoreAllMocks()
})

function wrapperFor(client: QueryClient) {
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

// Regression for #754: a guest who has browsed the app (matches/dashboard
// queries cached under the guest identity) must not keep seeing that data
// after a magic-link/confirm-email sign-in lands them on a *different*
// existing account (skip_merge) — the same leak `useLogout` already guards
// against.
describe('useConsumeLoginToken', () => {
  it("clears the prior guest's caches before seeding the new session", async () => {
    queryClient.setQueryData(['matches', 'list'], { stale: 'guest data' })
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json({
          data: { user: { id: 'u-2', username: 'new-user' } },
        }),
      ),
    )

    const { result } = renderHook(() => useConsumeLoginToken(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate({ token: 'tok' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(['matches', 'list'])).toBeUndefined()
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({
      data: { user: { id: 'u-2' } },
    })
  })

  // Regression for #239: `GET /v1/session` never returns `merged`, so a
  // truthy value seeded here would sit in the cache for the full 5-minute
  // staleTime and could mislead a future `useSession().data.merged` reader.
  it('strips `merged` before caching the session (#239)', async () => {
    server.use(
      http.post('*/v1/login/consume', () =>
        HttpResponse.json({
          data: { user: { id: 'u-2', username: 'new-user' } },
          merged: { matches_moved: 3 },
        }),
      ),
    )

    const { result } = renderHook(() => useConsumeLoginToken(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate({ token: 'tok' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(
      (queryClient.getQueryData(SESSION_QUERY_KEY) as { merged: unknown })
        .merged,
    ).toBeNull()
  })
})

describe('useConfirmEmail', () => {
  it("clears the prior guest's caches before seeding the new session", async () => {
    queryClient.setQueryData(['dashboard'], { stale: 'guest data' })
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json({
          data: { user: { id: 'u-2', username: 'new-user' } },
        }),
      ),
    )

    const { result } = renderHook(() => useConfirmEmail(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate({ token: 'tok' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined()
    expect(queryClient.getQueryData(SESSION_QUERY_KEY)).toMatchObject({
      data: { user: { id: 'u-2' } },
    })
  })

  // Regression for #239: same fix as useConsumeLoginToken above.
  it('strips `merged` before caching the session (#239)', async () => {
    server.use(
      http.post('*/v1/me/email/confirm', () =>
        HttpResponse.json({
          data: { user: { id: 'u-2', username: 'new-user' } },
          merged: { matches_moved: 1 },
        }),
      ),
    )

    const { result } = renderHook(() => useConfirmEmail(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate({ token: 'tok' })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(
      (queryClient.getQueryData(SESSION_QUERY_KEY) as { merged: unknown })
        .merged,
    ).toBeNull()
  })
})

describe('useLogout', () => {
  /**
   * ⚠️ The ordering assertion, on the path most exposed to it. Signing out is
   * always done from inside `_app`, where `RealtimeProvider` has a live
   * `/v1/stream`. `queryClient.clear()` is synchronous but the navigation that
   * unmounts the provider is not, so a hint arriving in that gap would refetch
   * the departing user's dashboard straight back into the cache that was just
   * emptied — in front of whoever signs in next.
   *
   * Recorded as a LIST, not two `toHaveBeenCalled()`s: with the steps the wrong
   * way round both spies are still satisfied and the bug still ships.
   */
  it('closes the realtime stream before clearing the query cache', async () => {
    const calls: string[] = []
    vi.mocked(closeRealtimeConnections).mockImplementation(() => {
      calls.push('closeRealtime')
    })
    vi.spyOn(queryClient, 'clear').mockImplementation(() => {
      calls.push('clearQueryCache')
    })

    const { result } = renderHook(() => useLogout(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(calls).toEqual(['closeRealtime', 'clearQueryCache'])
  })

  // The behaviour the ordering protects, end to end: nothing per-user survives.
  it("drops the prior user's cached per-user data", async () => {
    queryClient.setQueryData(['dashboard'], { stale: 'signed-in data' })

    const { result } = renderHook(() => useLogout(), {
      wrapper: wrapperFor(queryClient),
    })
    result.current.mutate()

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(queryClient.getQueryData(['dashboard'])).toBeUndefined()
  })
})

// The cross-tab bootstrap lock lives in localStorage — untrusted persisted
// state. `readStorageLock` must parse it at the boundary so a malformed or
// hand-edited record reads as "no lock" instead of casting garbage inward
// (`.claude/rules/parse-at-boundaries.md`).
describe('readStorageLock', () => {
  const LOCK_KEY = 'fortymm:session-bootstrap:lock'

  afterEach(() => {
    localStorage.removeItem(LOCK_KEY)
  })

  it('returns null when no lock is stored', () => {
    expect(readStorageLock()).toBeNull()
  })

  it('parses a well-formed record', () => {
    localStorage.setItem(
      LOCK_KEY,
      JSON.stringify({ owner: 'tab-1', expires: 123 }),
    )
    expect(readStorageLock()).toEqual({ owner: 'tab-1', expires: 123 })
  })

  it('rejects non-JSON as null', () => {
    localStorage.setItem(LOCK_KEY, 'not json{')
    expect(readStorageLock()).toBeNull()
  })

  it('rejects a wrong-shaped record (expires as string) as null', () => {
    localStorage.setItem(
      LOCK_KEY,
      JSON.stringify({ owner: 'tab-1', expires: '123' }),
    )
    expect(readStorageLock()).toBeNull()
  })

  it('rejects a record missing fields as null', () => {
    localStorage.setItem(LOCK_KEY, JSON.stringify({ owner: 'tab-1' }))
    expect(readStorageLock()).toBeNull()
  })
})

describe('useLoginSender (#1466 defect 1)', () => {
  it('parses the bare address off GET /v1/login/sender', async () => {
    server.use(
      http.get('*/v1/login/sender', () =>
        HttpResponse.json({ address: 'noreply@fortymm.com' }),
      ),
    )
    const { result } = renderHook(() => useLoginSender(), {
      wrapper: wrapperFor(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBe('noreply@fortymm.com')
  })

  it('resolves to null, not an error, when the API has no address', async () => {
    server.use(
      http.get('*/v1/login/sender', () => HttpResponse.json({ address: null })),
    )
    const { result } = renderHook(() => useLoginSender(), {
      wrapper: wrapperFor(queryClient),
    })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toBeNull()
  })

  it('surfaces a malformed response as a query error rather than a thrown boundary error', async () => {
    server.use(
      http.get('*/v1/login/sender', () =>
        HttpResponse.json({ address: 42 }),
      ),
    )
    const { result } = renderHook(() => useLoginSender(), {
      wrapper: wrapperFor(queryClient),
    })

    await waitFor(() => expect(result.current.isError).toBe(true))
  })
})
