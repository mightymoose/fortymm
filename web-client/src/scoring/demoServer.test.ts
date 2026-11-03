import { describe, expect, it } from 'vitest'
import { fetchBoard, sendChange } from './demoServer'
import type { Change } from './scratchpad'

const ann = { playerId: 'b3c7a0d2-0000-4000-8000-000000000001', name: 'excited egret 387' }

function save(id: string, points: [number, number]): Change {
  return { id, edit: { kind: 'save', game: 1, points, savedBy: ann } }
}

describe('the demo server', () => {
  it('applies a change once, so a late copy can’t undo the correction after it', async () => {
    const old = save('c1', [11, 3])
    await sendChange('d1', old)
    await sendChange('d1', save('c2', [11, 5]))
    await sendChange('d1', old)

    expect((await fetchBoard('d1')).games[1]?.points).toEqual([11, 5])
  })
})
