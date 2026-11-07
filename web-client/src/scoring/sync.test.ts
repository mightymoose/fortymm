import { describe, expect, it } from 'vitest'
import { ApiError, ApiUnreachable } from '../api/errors'
import type { MatchResult } from '../signing/result'
import { signResult } from '../signing/envelope'
import { base64url } from '../signing/text'
import { notYet } from './results'
import { nextStep, retryable, retryDelay, stuckAfter } from './sync'

describe('nextStep', () => {
  it('sends a waiting board online, and waits while offline', () => {
    expect(nextStep({ pending: 'a', result: null, offline: false })).toBe('sendBoard')
    expect(nextStep({ pending: 'a', result: null, offline: true })).toBe('waitOnline')
  })

  it('rests with nothing to send, online or offline', () => {
    expect(nextStep({ pending: null, result: null, offline: false })).toBe('rest')
    expect(nextStep({ pending: null, result: null, offline: true })).toBe('rest')
  })

  it('sends the board before a result, and waits with either while offline', () => {
    expect(nextStep({ pending: 'a', result: 'r', offline: false })).toBe('sendBoard')
    expect(nextStep({ pending: null, result: 'r', offline: false })).toBe('sendResult')
    expect(nextStep({ pending: null, result: 'r', offline: true })).toBe('waitOnline')
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

describe('notYet', () => {
  const NOW = Date.UTC(2026, 10, 7, 12)
  const forbidden = new ApiError('POST', new Response(null, { status: 403 }))
  const signedAt = async (issuedAt: number) => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
    const signer = {
      kid: new Uint8Array(32),
      sign: async (bytes: Uint8Array<ArrayBuffer>) =>
        new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)),
    }
    const result = {
      match: '01970000-0000-7000-8000-0000000000c8',
      bestOf: 1,
      rated: false,
      players: ['6f1d2c43-8b5e-4a0f-9c71-2e4b8d0a5f13', '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40'],
      games: [[11, 5]],
      ending: 'completed',
      replaces: null,
    } as MatchResult
    return base64url(await signResult(signer, issuedAt, result, 0))
  }
  const seconds = (ms: number) => Math.floor(ms / 1000)

  it('keeps trying a result signed within the last day', async () => {
    expect(notYet(forbidden, await signedAt(seconds(NOW - 23 * 3600_000)), NOW)).toBe(true)
  })

  it('gives up on a result signed more than a day ago', async () => {
    expect(notYet(forbidden, await signedAt(seconds(NOW - 25 * 3600_000)), NOW)).toBe(false)
  })

  it('trusts a signing time only up to an hour ahead of this device’s clock', async () => {
    expect(notYet(forbidden, await signedAt(seconds(NOW + 30 * 60_000)), NOW)).toBe(true)
    expect(notYet(forbidden, await signedAt(seconds(NOW + 2 * 3600_000)), NOW)).toBe(false)
    expect(notYet(forbidden, await signedAt(253_402_300_799), NOW)).toBe(false)
  })
})
