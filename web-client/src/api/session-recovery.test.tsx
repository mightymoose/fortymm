import { createElement, type ReactNode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { delay, http, HttpResponse } from 'msw'
import { mockSession } from '@/mocks/handlers'
import { server } from '@/mocks/server'
import { blockLocalStorage } from '@/test/blocked-storage'
import { forgetSessionEnd, readEndedSession, rememberSessionEnd } from './browser-session'
import { sessionQueryOptions, useLogout, useStartNewGuest, useConfirmEmail, useConsumeLoginToken, type SessionUser } from './session'

const clients: QueryClient[] = []
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

afterEach(() => {
  vi.unstubAllGlobals()
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

it.each([
  [false, undefined], [false, 'getItem'], [false, 'setItem'],
  [true, undefined], [true, 'getItem'], [true, 'setItem'],
] as const)('coordinates recovery with Web Locks %s and %s blocked', async (webLocks, blockedMethod) => {
  if (!webLocks) vi.stubGlobal('navigator', { locks: undefined })
  if (webLocks) {
    let queue: Promise<unknown> = Promise.resolve()
    vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => Promise<unknown>) => {
      const result = queue.then(run, run)
      queue = result.catch(() => undefined)
      return result
    } } })
  }
  if (blockedMethod) blockLocalStorage(blockedMethod)
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
    if (blockedMethod || !webLocks) {
      await expect(first.result.current.mutateAsync()).rejects.toThrow()
      await expect(second.result.current.mutateAsync()).rejects.toThrow()
    } else {
      const [a, b] = await Promise.all([
        first.result.current.mutateAsync(), second.result.current.mutateAsync(),
      ])
      expect(a.data.user.id).toBe(b.data.user.id)
    }
  })
  expect(minted).toBe(blockedMethod || !webLocks ? 0 : 1)
  expect(deletes).toBe(blockedMethod || !webLocks ? 0 : 1)
})

it('keeps a slow new-guest recovery exclusive across repeated choices', async () => {
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

it.each([
  ['/v1/me/email/confirm', useConfirmEmail],
  ['/v1/login/consume', useConsumeLoginToken],
] as const)('finishes pending logout before redeeming %s', async (endpoint, useFinalize) => {
  rememberSessionEnd({ message: 'Sign-out incomplete.', logoutPending: true })
  let deletes = 0
  let redemptions = 0
  server.use(
    http.delete('*/v1/session', () => {
      deletes += 1
      return new HttpResponse(null, { status: deletes === 1 ? 503 : 204 })
    }),
    http.post(`*${endpoint}`, () => {
      redemptions += 1
      return HttpResponse.json(mockSession)
    }),
  )
  const { result } = renderHook(() => useFinalize(), { wrapper: wrapper() })
  await act(async () => {
    await expect(result.current.mutateAsync({ token: 'other-account' })).rejects.toThrow()
    expect(redemptions).toBe(0)
    expect(readEndedSession()?.logoutPending).toBe(true)
    await result.current.mutateAsync({ token: 'other-account' })
  })
  expect(deletes).toBe(2)
  expect(redemptions).toBe(1)
  expect(readEndedSession()).toBeNull()
})

it('reuses peer recovery before its completion broadcast reaches a fallback tab', async () => {
  blockLocalStorage('setItem')
  rememberSessionEnd({ message: 'Your session ended.' })
  vi.unstubAllGlobals()
  // A peer completed under the lock; this tab has not received any event.
  localStorage.setItem('fortymm.session-ended', 'null')
  expect(readEndedSession()).not.toBeNull()
  let deletes = 0
  server.use(
    http.delete('*/v1/session', () => {
      deletes += 1
      return new HttpResponse(null, { status: 204 })
    }),
    http.get('*/v1/session', () => HttpResponse.json(mockSession)),
  )
  const { result } = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  await act(async () => {
    const session = await result.current.mutateAsync()
    expect(session.data.user.id).toBe(mockSession.data.user.id)
  })
  expect(deletes).toBe(0)
  expect(readEndedSession()).toBeNull()
})

it.each([
  [false, 'getItem'], [false, 'setItem'],
  [true, 'getItem'], [true, 'setItem'],
] as const)('revokes logout with Web Locks %s and %s blocked', async (webLocks, blockedMethod) => {
  if (!webLocks) vi.stubGlobal('navigator', { locks: undefined })
  if (webLocks) vi.stubGlobal('navigator', { locks: { request: (_name: string, run: () => Promise<unknown>) => run() } })
  blockLocalStorage(blockedMethod)
  let deletes = 0
  server.use(http.delete('*/v1/session', () => {
    deletes += 1
    return new HttpResponse(null, { status: 204 })
  }))
  const { result } = renderHook(() => useLogout(), { wrapper: wrapper() })
  await act(() => result.current.mutateAsync())
  expect(deletes).toBe(1)
  expect(readEndedSession()?.logoutPending).toBe(false)
})

it.each([useConfirmEmail, useConsumeLoginToken])('serializes link redemption with an active new-guest choice', async (useFinalize) => {
  rememberSessionEnd({ message: 'Your session ended.' })
  let release!: () => void
  let started!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const waiting = new Promise<void>((resolve) => { started = resolve })
  let redemptions = 0
  server.use(
    http.delete('*/v1/session', () => new HttpResponse(null, { status: 204 })),
    http.get('*/v1/session', async () => { started(); await held; return HttpResponse.json(mockSession) }),
    http.post('*/v1/login/consume', () => { redemptions++; return HttpResponse.json(mockSession) }),
    http.post('*/v1/me/email/confirm', () => { redemptions++; return HttpResponse.json(mockSession) }),
  )
  const guest = renderHook(() => useStartNewGuest(), { wrapper: wrapper() })
  const link = renderHook(() => useFinalize(), { wrapper: wrapper() })
  await act(async () => {
    const recovering = guest.result.current.mutateAsync()
    await waiting
    const redeeming = link.result.current.mutateAsync({ token: 'approved-link' })
    try {
      await delay(25)
      expect(redemptions).toBe(0)
    } finally {
      release()
      await Promise.all([recovering, redeeming])
    }
  })
  expect(redemptions).toBe(1)
})
