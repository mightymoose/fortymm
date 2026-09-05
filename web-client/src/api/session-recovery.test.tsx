import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { mockSession } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { forgetSessionEnd, readEndedSession, rememberSessionEnd } from './browser-session'
import { sessionQueryOptions, useLogout, useStartNewGuest, type SessionUser } from './session'

const clients: QueryClient[] = []
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

afterEach(() => {
  vi.restoreAllMocks()
  clients.splice(0).forEach((client) => client.clear())
  forgetSessionEnd()
  document.cookie = 'csrf_token=; Max-Age=0; path=/'
})

it('shares sign-out before cookies are cleared and prevents another guest bootstrap', async () => {
  let endedBeforeCookieClear = false
  server.use(http.delete('*/v1/session', () => {
    endedBeforeCookieClear = readEndedSession() !== null
    return new HttpResponse(null, { status: 204 })
  }))
  const { result } = renderHook(() => useLogout(), { wrapper: wrapper() })
  await act(() => result.current.mutateAsync())
  expect(endedBeforeCookieClear).toBe(true)
  const anotherTab = new QueryClient()
  clients.push(anotherTab)
  await expect(anotherTab.fetchQuery(sessionQueryOptions())).rejects.toMatchObject({ status: 401 })
})

it.each([undefined, 'getItem', 'setItem'] as const)('concurrent new-guest choices recover the same identity with %s blocked', async (blockedMethod) => {
  if (blockedMethod) vi.spyOn(Storage.prototype, blockedMethod).mockImplementation(() => { throw new Error('Storage unavailable') })
  rememberSessionEnd({ message: 'Your session ended.' })
  document.cookie = 'csrf_token=ended-session; path=/'
  let cookieUser: SessionUser | null = null
  let minted = 0
  let deletes = 0
  server.use(
    http.delete('*/v1/session', () => {
      deletes += 1
      cookieUser = null
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('*/v1/session', async () => {
      const user = cookieUser ?? { ...mockSession.data.user,
        id: crypto.randomUUID(), username: `guest-${++minted}`,
      }
      await delay(25)
      cookieUser = user
      return HttpResponse.json({ data: { user } })
    }),
  )
  const first = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  const second = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  await act(async () => {
    const [a, b] = await Promise.all([
      first.result.current.mutateAsync(), second.result.current.mutateAsync(),
    ])
    expect(a.data.user.id).toBe(b.data.user.id)
  })
  expect(minted).toBe(1)
  expect(deletes).toBe(1)
})

it('keeps a slow new-guest recovery exclusive beyond the fallback lock TTL', async () => {
  rememberSessionEnd({ message: 'Your session ended.' })
  document.cookie = 'csrf_token=ended-session; path=/'
  let deletes = 0
  server.use(
    http.delete('*/v1/session', () => {
      deletes += 1
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('*/v1/session', async () => {
      await delay(11_000)
      return HttpResponse.json(mockSession)
    }),
  )
  const first = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  const second = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  await act(async () => {
    const firstRecovery = first.result.current.mutateAsync()
    await delay(100)
    const secondRecovery = second.result.current.mutateAsync().catch(() => null)
    await delay(10_200)
    expect(deletes).toBe(1)
    await Promise.all([firstRecovery, secondRecovery])
  })
}, 30_000)
