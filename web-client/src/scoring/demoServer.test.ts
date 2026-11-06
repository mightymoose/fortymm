import { describe, expect, it } from 'vitest'
import { dropRequestsInFlight, fetchBoard, putBoard, serverBoard } from './demoServer'

describe('the demo server', () => {
  it('keeps the latest board per match', async () => {
    expect(await fetchBoard('d1')).toBeNull()

    await putBoard('d1', 'a')
    await putBoard('d1', 'b')

    expect(await fetchBoard('d1')).toBe('b')
  })

  it('drops a request in flight', async () => {
    const put = putBoard('d3', 'a')
    dropRequestsInFlight()

    await expect(put).rejects.toThrow()
    expect(serverBoard('d3')).toBeNull()
  })
})
