import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  applyChange,
  clearGame,
  markSent,
  pendingChanges,
  reopen,
  saveGame,
  slotsOf,
  storageKey,
  submitResult,
  useScratchpad,
} from './scratchpad'

const ann = { playerId: 'b3c7a0d2-0000-4000-8000-000000000001', name: 'excited egret 387' }

describe('scratchpad', () => {
  it('saves and clears games by game number', () => {
    const { result } = renderHook(() => useScratchpad('m1'))

    act(() => {
      saveGame('m1', 3, [11, 7], ann)
      saveGame('m1', 1, [9, 11], ann)
    })
    expect(slotsOf(result.current, 5)).toEqual([[9, 11], null, [11, 7], null, null])
    expect(result.current.games[3]?.savedBy).toEqual(ann)

    act(() => {
      clearGame('m1', 3)
    })
    expect(slotsOf(result.current, 5)).toEqual([[9, 11], null, null, null, null])
  })

  it('refuses game writes while the result is submitted', () => {
    saveGame('m2', 1, [11, 3], ann)
    submitResult('m2', { by: ann.playerId, games: [[11, 3]], winner: 0 })

    expect(saveGame('m2', 2, [11, 3], ann)).toBe(false)
    expect(clearGame('m2', 1)).toBe(false)

    reopen('m2')
    expect(saveGame('m2', 2, [11, 3], ann)).toBe(true)
  })

  it('follows a write from another tab', () => {
    const { result } = renderHook(() => useScratchpad('m3'))
    const record = { games: { 2: { points: [12, 10], savedBy: ann } }, submission: { phase: 'open' } }

    act(() => {
      localStorage.setItem(storageKey('m3'), JSON.stringify(record))
      window.dispatchEvent(new StorageEvent('storage', { key: storageKey('m3') }))
    })

    expect(slotsOf(result.current, 3)).toEqual([null, [12, 10], null])
  })

  it('leaves out what it can’t read', () => {
    localStorage.setItem(
      storageKey('m4'),
      JSON.stringify({
        games: { 1: { points: [11, 10], savedBy: ann }, 2: { points: [11, 4], savedBy: ann }, x: {} },
        submission: { phase: 'submitted', by: 7 },
      }),
    )
    const { result } = renderHook(() => useScratchpad('m4'))

    expect(slotsOf(result.current, 3)).toEqual([null, [11, 4], null])
    expect(result.current.submission).toEqual({ phase: 'open' })
  })

  it('queues each change for the server, in order, until it is sent', () => {
    saveGame('m5', 1, [11, 6], ann)
    clearGame('m5', 1)
    saveGame('m5', 2, [11, 8], ann)

    const outbox = pendingChanges('m5')
    expect(outbox.map((change) => change.kind)).toEqual(['save', 'clear', 'save'])

    markSent('m5', outbox[0].id)
    expect(pendingChanges('m5').map((change) => change.id)).toEqual([outbox[1].id, outbox[2].id])
  })

  it('applies a change to a board the same way on the device and the server', () => {
    const open = { games: {}, submission: { phase: 'open' } } as const
    const saved = applyChange(open, { id: 'a', kind: 'save', game: 1, points: [11, 2], savedBy: ann })
    expect(saved?.games[1]?.points).toEqual([11, 2])

    const submitted = applyChange(saved!, {
      id: 'b',
      kind: 'submit',
      submission: { phase: 'submitted', by: ann.playerId, games: [[11, 2]], winner: 0, submittedAt: 'now' },
    })
    expect(applyChange(submitted!, { id: 'c', kind: 'clear', game: 1 })).toBeNull()
  })
})
