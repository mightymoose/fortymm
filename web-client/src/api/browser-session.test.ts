import { blockLocalStorage } from '@/test/blocked-storage'
import { waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { forgetSessionEnd, readEndedSession, rememberSessionEnd, subscribeSessionEnd } from './browser-session'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  forgetSessionEnd()
})

it('keeps this tab signed out when storage reads work but writes fail', () => {
  blockLocalStorage('setItem')
  rememberSessionEnd({ message: 'Sign in again.' })
  expect(readEndedSession()).toEqual({ message: 'Sign in again.' })
})

it('broadcasts session end when shared storage writes fail', async () => {
  const peer = new BroadcastChannel('fortymm:session-ended')
  const received: unknown[] = []
  peer.onmessage = (event) => { received.push(JSON.parse(event.data)) }
  blockLocalStorage('setItem')
  try {
    rememberSessionEnd({ message: 'Signed out remotely.' })
    await waitFor(() => expect(received).toContainEqual({ sender: expect.any(String), value: { message: 'Signed out remotely.' } }))
  } finally { peer.close() }
})

it('keeps a fallback broadcast after this tab reloads', async () => {
  blockLocalStorage('setItem')
  const stop = subscribeSessionEnd(() => undefined)
  const peer = new BroadcastChannel('fortymm:session-ended')
  try {
    peer.postMessage(JSON.stringify({ sender: 'other-tab', value: { message: 'Signed out in another tab.' } }))
    await waitFor(() => expect(readEndedSession()?.message).toBe('Signed out in another tab.'))
    vi.resetModules()
    const reloaded = await import('./browser-session')
    expect(reloaded.readEndedSession()?.message).toBe('Signed out in another tab.')
    reloaded.forgetSessionEnd()
  } finally { stop(); peer.close() }
})

it('honors completed recovery in shared storage when a closed tab returns', async () => {
  rememberSessionEnd({ message: 'Signed out.' })
  // Another tab signed in while this tab had no running listeners.
  localStorage.removeItem('fortymm.session-ended')
  vi.resetModules()
  const reopened = await import('./browser-session')
  expect(reopened.readEndedSession()).toBeNull()
})
