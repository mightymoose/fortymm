import { describe, expect, it } from 'vitest'
import { ApiError, ApiUnreachable } from '../api/errors'
import { nextStep, retryable, retryDelay, stuckAfter } from './sync'

describe('nextStep', () => {
  it('sends a waiting board online, and waits while offline', () => {
    expect(nextStep({ pending: 'a', offline: false })).toBe('send')
    expect(nextStep({ pending: 'a', offline: true })).toBe('waitOnline')
  })

  it('rests with nothing to send, online or offline', () => {
    expect(nextStep({ pending: null, offline: false })).toBe('rest')
    expect(nextStep({ pending: null, offline: true })).toBe('rest')
  })
})

describe('retries', () => {
  it('backs off 2, 4, 8, 15, then 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(retryDelay)).toEqual([2000, 4000, 8000, 15000, 30000, 30000, 30000])
  })

  it('drops a board on a 4xx other than 429', () => {
    const answer = (status: number) => new ApiError('PUT', new Response(null, { status }))
    expect(retryable(answer(409))).toBe(false)
    expect(retryable(answer(429))).toBe(true)
    expect(retryable(answer(503))).toBe(true)
    expect(retryable(new ApiUnreachable('PUT', { cause: new TypeError('Failed to fetch') }))).toBe(true)
  })
})

describe('stuckAfter', () => {
  const answer = (status: number) => new ApiError('PUT', new Response(null, { status }))
  const unreachable = new ApiUnreachable('PUT', { cause: new TypeError('Failed to fetch') })

  it('is offline when no response came back, from the first failure', () => {
    expect(stuckAfter(unreachable, 1, null)).toBe('offline')
  })

  it('is failing from the first 429, as its wait can last minutes', () => {
    expect(stuckAfter(answer(429), 1, null)).toBe('failed')
  })

  it.each([502, 503, 504, 500])('is failing from the second %i in a row, never offline', (status) => {
    expect(stuckAfter(answer(status), 1, null)).toBeNull()
    expect(stuckAfter(answer(status), 2, null)).toBe('failed')
    expect(stuckAfter(answer(status), 2, 'offline')).toBe('failed')
  })

  it('keeps why it was stuck after one failure with a response', () => {
    expect(stuckAfter(answer(503), 1, 'offline')).toBe('offline')
  })
})
