import { http } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type ApiClient } from '../api/client'
import { ApiError, ApiUnreachable } from '../api/errors'
import { pushBoard } from './boardApi'
import { draftHash } from './fragment'
import { apiMatch } from './matches'
import { API_BASE_URL, mockBoards, server } from '../test/server'

const match = apiMatch('01970000-0000-7000-8000-0000000000d2', 3, false, [
  '0c9e7b21-3d4a-4f68-a1b5-7e2f9c8d6a40',
  'a4d8f0e6-1b2c-4e3d-8f5a-9c7b6e1d2f08',
])
const board = draftHash(match, [[11, 7]], null, 1_793_700_000)

describe('pushBoard', () => {
  let api: ApiClient

  // After MSW starts, as the client keeps the fetch it was made with.
  beforeEach(() => {
    api = createApiClient({ baseUrl: API_BASE_URL })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('sends the hex of the fragment’s bytes', async () => {
    const boards = mockBoards()

    await pushBoard(api, match.id, board)

    expect(boards.pushes).toEqual([
      {
        matchId: match.id,
        board:
          'a2061a6ae9b0a077666f7274796d6d2f6d617463682d726573756c742f7631a60150019700000000700080000000000000d2020303f40482500c9e7b213d4a4f68a1b57e2f9c8d6a4050a4d8f0e61b2c4e3d8f5a9c7b6e1d2f080581820b070600',
      },
    ])
    expect(boards.board(match.id)).toBe(board)
  })

  it('rejects a refusal with its status', async () => {
    const boards = mockBoards()
    boards.answers.push({ status: 409 })

    const pushed = pushBoard(api, match.id, board)

    await expect(pushed).rejects.toBeInstanceOf(ApiError)
    await expect(pushed).rejects.toMatchObject({ status: 409 })
  })

  it('gives up with no response after 10 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    // Fake timers don't reach AbortSignal.timeout(), so this one runs on
    // the faked setTimeout.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The request timed out', 'TimeoutError')), ms)
      return controller.signal
    })
    server.use(http.post(`${API_BASE_URL}/v1/matches/:matchId/boards`, () => new Promise<Response>(() => {})))

    const pushed = pushBoard(api, match.id, board)
    const settled = pushed.catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(9_900)
    await expect(Promise.race([settled, 'pending'])).resolves.toBe('pending')
    await vi.advanceTimersByTimeAsync(200)

    await expect(settled).resolves.toBeInstanceOf(ApiUnreachable)
  })

  it('asks the browser to keep the request alive', async () => {
    mockBoards()
    // MSW's copy of the request drops `keepalive`, so this reads the
    // request the client hands to fetch.
    const sent: Request[] = []
    const watched = createApiClient({
      baseUrl: API_BASE_URL,
      fetch: (request: Request) => {
        sent.push(request)
        return fetch(request)
      },
    })

    await pushBoard(watched, match.id, board)

    expect(sent.map((request) => request.keepalive)).toEqual([true])
  })
})
