import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { server } from '@/mocks/server'
import {
  SESSION_QUERY_KEY,
  readStorageLock,
  useConfirmEmail,
  useConsumeLoginToken,
} from './session'

let queryClient: QueryClient

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
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
