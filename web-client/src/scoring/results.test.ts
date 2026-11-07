import { afterEach, describe, expect, it, vi } from 'vitest'
import { matchesWithResults, queueResult, removeResult, resultsOf, subscribeResults } from './results'

describe('the results outbox', () => {
  it('keeps each match’s results oldest first, and the same one once', () => {
    queueResult('m', 'first')
    queueResult('m', 'correction')
    queueResult('m', 'first')
    queueResult('other', 'x')

    expect(resultsOf('m')).toEqual(['first', 'correction'])
    expect(matchesWithResults().sort()).toEqual(['m', 'other'])
  })

  it('outlasts the tab, in localStorage', () => {
    queueResult('m', 'first')

    expect(JSON.parse(localStorage.getItem('fortymm-results')!)).toEqual({ m: ['first'] })
  })

  it('forgets a match once its last result is taken', () => {
    queueResult('m', 'first')
    queueResult('m', 'correction')

    removeResult('m', 'first')
    expect(resultsOf('m')).toEqual(['correction'])
    removeResult('m', 'correction')
    expect(matchesWithResults()).toEqual([])
  })

  it('hears a result another tab queued', () => {
    let heard = 0
    const unsubscribe = subscribeResults(() => (heard += 1))
    localStorage.setItem('fortymm-results', JSON.stringify({ m: ['theirs'] }))
    window.dispatchEvent(new StorageEvent('storage', { key: 'fortymm-results' }))
    unsubscribe()

    expect(heard).toBe(1)
    expect(resultsOf('m')).toEqual(['theirs'])
  })

  describe('when localStorage refuses a write', () => {
    afterEach(() => vi.restoreAllMocks())

    const full = () =>
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
      })

    it('still holds a first result', () => {
      full()
      queueResult('m', 'first')
      expect(resultsOf('m')).toEqual(['first'])
    })

    it('still holds a correction after the first result was stored', () => {
      queueResult('m', 'first')
      full()
      queueResult('m', 'correction')
      expect(resultsOf('m')).toEqual(['first', 'correction'])
    })
  })

  it('writes under a Web Lock, so two tabs’ changes take turns', async () => {
    const held: string[] = []
    vi.stubGlobal('navigator', {
      ...navigator,
      locks: { request: async (name: string, run: () => void) => (held.push(name), run()) },
    })
    try {
      queueResult('m', 'first')
      removeResult('m', 'first')
    } finally {
      vi.unstubAllGlobals()
    }

    expect(held).toEqual(['fortymm-results', 'fortymm-results'])
    expect(resultsOf('m')).toEqual([])
  })
})

