import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { serverKey, setDemoNetwork } from './demoServer'
import { pendingChanges, readBoard, saveGame, writeBoard } from './scratchpad'
import { useSync } from './sync'

const ann = { playerId: 'b3c7a0d2-0000-4000-8000-000000000001', name: 'excited egret 387' }

describe('useSync', () => {
  it('sends the outbox, then pulls the server’s board', async () => {
    writeBoard(serverKey('s1'), { games: { 2: { points: [4, 11], savedBy: ann } }, submission: { phase: 'open' } })
    saveGame('s1', 1, [11, 3], ann)

    const { result } = renderHook(() => useSync('s1'))

    expect(result.current.sending?.edit).toMatchObject({ kind: 'save', game: 1 })
    await waitFor(() => expect(pendingChanges('s1')).toEqual([]))
    await waitFor(() => expect(result.current.pulling).toBe(false))
    expect(readBoard(serverKey('s1')).games[1]?.points).toEqual([11, 3])
  })

  it('keeps a change whose answer lands after the last holder let go', async () => {
    saveGame('s2', 1, [11, 3], ann)
    const { result, unmount } = renderHook(() => useSync('s2'))
    expect(result.current.sending).not.toBeNull()

    unmount()
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(pendingChanges('s2')).toHaveLength(1)
  })

  it('drops a change the server refuses for good', async () => {
    writeBoard(serverKey('s3'), {
      games: {},
      submission: { phase: 'submitted', by: ann.playerId, games: [], submittedAt: 'now' },
    })
    saveGame('s3', 1, [11, 3], ann)

    const { result } = renderHook(() => useSync('s3'))

    await waitFor(() => expect(pendingChanges('s3')).toEqual([]))
    expect(result.current.stuck).toBeNull()
  })

  it('waits while offline, and sends as soon as the network comes back', async () => {
    act(() => setDemoNetwork('offline'))
    saveGame('s4', 1, [11, 3], ann)
    const { result } = renderHook(() => useSync('s4'))

    expect(result.current.stuck).toBe('offline')
    expect(result.current.sending).toBeNull()

    act(() => setDemoNetwork('normal'))

    expect(result.current.sending).not.toBeNull()
    await waitFor(() => expect(pendingChanges('s4')).toEqual([]))
    expect(result.current.stuck).toBeNull()
  })
})
