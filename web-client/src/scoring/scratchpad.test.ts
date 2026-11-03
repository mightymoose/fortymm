import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  applyEdit,
  clearGame,
  markSent,
  pendingChanges,
  readBoard,
  receiveBoard,
  reopen,
  saveGame,
  slotsOf,
  storageKey,
  submitResult,
  useScratchpad,
  type Board,
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
    submitResult('m2', ann.playerId, [[11, 3]])

    expect(saveGame('m2', 2, [11, 3], ann)).toBe(false)
    expect(clearGame('m2', 1)).toBe(false)

    reopen('m2')
    expect(saveGame('m2', 2, [11, 3], ann)).toBe(true)
  })

  it('keeps the games a submission approved', () => {
    saveGame('m7', 1, [11, 3], ann)
    submitResult('m7', ann.playerId, [[11, 3], [11, 4]])

    expect(readBoard(storageKey('m7')).submission).toMatchObject({
      phase: 'submitted',
      by: ann.playerId,
      games: [[11, 3], [11, 4]],
    })
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

  it('leaves out each game and change it can’t read, and keeps the rest', () => {
    localStorage.setItem(
      storageKey('m4'),
      JSON.stringify({
        games: { 1: { points: [11, 10], savedBy: ann }, 2: { points: [11, 4], savedBy: ann }, x: {} },
        submission: { phase: 'submitted', by: 7 },
        outbox: [
          { id: 'a', edit: { kind: 'clear', game: 12 } },
          { id: 'b', edit: { kind: 'clear', game: 2 } },
          { id: 'c', edit: { kind: 'wipe' } },
        ],
      }),
    )
    const { result } = renderHook(() => useScratchpad('m4'))

    expect(slotsOf(result.current, 3)).toEqual([null, [11, 4], null])
    expect(result.current.submission).toEqual({ phase: 'open' })
    expect(result.current.outbox.map((change) => change.id)).toEqual(['b'])
  })

  it('reads a record that isn’t JSON as an empty board', () => {
    localStorage.setItem(storageKey('m8'), '{')

    expect(readBoard(storageKey('m8'))).toEqual({ games: {}, submission: { phase: 'open' } })
  })

  it('works in this tab when storage throws', () => {
    const failing = () => {
      throw new DOMException('Storage is off', 'SecurityError')
    }
    const spies = [
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(failing),
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(failing),
    ]
    try {
      const { result } = renderHook(() => useScratchpad('m9'))
      act(() => {
        saveGame('m9', 1, [11, 2], ann)
      })

      expect(slotsOf(result.current, 3)).toEqual([[11, 2], null, null])
      expect(pendingChanges('m9')).toHaveLength(1)
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('keeps a save in this tab when storage is full but still reads', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is full', 'QuotaExceededError')
    })
    try {
      const { result } = renderHook(() => useScratchpad('m-full'))
      act(() => {
        saveGame('m-full', 1, [11, 2], ann)
      })

      expect(slotsOf(result.current, 3)).toEqual([[11, 2], null, null])
      expect(pendingChanges('m-full')).toHaveLength(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('queues each change for the server, in order, until it is sent', () => {
    saveGame('m5', 1, [11, 6], ann)
    clearGame('m5', 1)
    saveGame('m5', 2, [11, 8], ann)

    const outbox = pendingChanges('m5')
    expect(outbox.map((change) => change.edit.kind)).toEqual(['save', 'clear', 'save'])

    markSent('m5', outbox[0].id)
    expect(pendingChanges('m5').map((change) => change.id)).toEqual([outbox[1].id, outbox[2].id])
  })

  it('refuses a game write to a submitted board', () => {
    const open: Board = { games: {}, submission: { phase: 'open' } }
    const saved = applyEdit(open, { kind: 'save', game: 1, points: [11, 2], savedBy: ann })
    expect(saved?.games[1]?.points).toEqual([11, 2])

    const submitted = applyEdit(saved!, {
      kind: 'submit',
      submission: { phase: 'submitted', by: ann.playerId, games: [[11, 2]], submittedAt: 'now' },
    })
    expect(applyEdit(submitted!, { kind: 'clear', game: 1 })).toBeNull()
  })

  it('leaves no record for an empty board', () => {
    receiveBoard('m10', { games: {}, submission: { phase: 'open' } })

    expect(localStorage.getItem(storageKey('m10'))).toBeNull()
  })

  it('takes a pulled board with the unsent changes on top', () => {
    saveGame('m6', 1, [11, 9], ann)
    receiveBoard('m6', {
      games: { 1: { points: [11, 2], savedBy: ann }, 2: { points: [3, 11], savedBy: ann } },
      submission: { phase: 'open' },
    })

    expect(slotsOf(readBoard(storageKey('m6')), 3)).toEqual([[11, 9], [3, 11], null])
    expect(pendingChanges('m6')).toHaveLength(1)
  })
})
