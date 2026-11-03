import { describe, expect, it } from 'vitest'
import { ApiError, ApiUnreachable } from '../api/errors'
import { nextStep, retryable, retryDelay } from './sync'

describe('nextStep', () => {
  it('sends a waiting board before it pulls, and waits while offline', () => {
    expect(nextStep({ pending: 'a', offline: false, wantsPull: true })).toBe('send')
    expect(nextStep({ pending: 'a', offline: true, wantsPull: true })).toBe('waitOnline')
  })

  it('pulls only with nothing to send, online and wanted', () => {
    expect(nextStep({ pending: null, offline: false, wantsPull: true })).toBe('pull')
    expect(nextStep({ pending: null, offline: true, wantsPull: true })).toBe('rest')
    expect(nextStep({ pending: null, offline: false, wantsPull: false })).toBe('rest')
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
