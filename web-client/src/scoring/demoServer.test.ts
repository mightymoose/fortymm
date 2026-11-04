import { describe, expect, it } from 'vitest'
import { ApiError } from '../api/errors'
import { fetchBoard, putBoard, resetMatch, serverBoard, setDemoNetwork } from './demoServer'

describe('the demo server', () => {
  it('keeps the latest board per match', async () => {
    expect(await fetchBoard('d1')).toBeNull()

    await putBoard('d1', 'a')
    await putBoard('d1', 'b')

    expect(await fetchBoard('d1')).toBe('b')
  })

  it('fails every second request on the flaky network', async () => {
    setDemoNetwork('flaky')

    await putBoard('d2', 'a')
    await expect(putBoard('d2', 'b')).rejects.toBeInstanceOf(ApiError)

    expect(serverBoard('d2')).toBe('a')
  })

  it('drops a request in flight when the match resets', async () => {
    const put = putBoard('d3', 'a')
    resetMatch('d3')

    await expect(put).rejects.toThrow()
    expect(serverBoard('d3')).toBeNull()
  })
})
