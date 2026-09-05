import { afterEach, expect, it, vi } from 'vitest'
import { forgetSessionEnd, readEndedSession, rememberSessionEnd } from './browser-session'

afterEach(() => {
  vi.restoreAllMocks()
  forgetSessionEnd()
})

it('keeps this tab signed out when storage reads work but writes fail', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Quota exhausted', 'QuotaExceededError')
  })
  rememberSessionEnd({ message: 'Sign in again.' })
  expect(readEndedSession()).toEqual({ message: 'Sign in again.' })
})
