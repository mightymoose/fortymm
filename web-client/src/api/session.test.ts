import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import { server } from '@/mocks/server'
import {
  SESSION_QUERY_KEY,
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
})
