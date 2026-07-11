import { HttpResponse } from 'msw'

import { mockSessionEndpoint } from '@/mocks/endpoints/session/session.endpoint'
import { server } from '@/mocks/server'
import { sessionResponse } from '@/test/factories'
import { renderHook, waitFor } from '@/test/utilities'

import { useIsViewer, useViewerId } from './viewer'

const signInAs = (id: string) =>
  mockSessionEndpoint(server, () =>
    HttpResponse.json(sessionResponse({ user: { id } })),
  )

describe('useViewerId', () => {
  it('reports the caller’s own player id, once the session lands', async () => {
    signInAs('p-7')

    const { result } = renderHook(() => useViewerId())

    await waitFor(() => expect(result.current).toBe('p-7'))
  })

  it('is null while the session is still in flight', () => {
    signInAs('p-7')

    const { result } = renderHook(() => useViewerId())

    expect(result.current).toBeNull()
  })
})

describe('useIsViewer', () => {
  it('is true on your OWN profile', async () => {
    signInAs('p-1')

    const { result } = renderHook(() => useIsViewer('p-1'))

    await waitFor(() => expect(result.current).toBe(true))
  })

  it('is false on somebody ELSE’s profile, however long you wait', async () => {
    signInAs('p-9')

    const { result } = renderHook(() => useIsViewer('p-1'))

    // Let the session resolve, then confirm it did not flip.
    const { result: viewer } = renderHook(() => useViewerId())
    await waitFor(() => expect(viewer.current).toBe('p-9'))
    expect(result.current).toBe(false)
  })

  it('is false — never true — while the session is unknown', async () => {
    // Third person is the voice it is safe to be caught in: "where they stand" on
    // your own profile for a frame is a wobble; "where you stand" on a stranger's
    // is a lie. A failing session must land on the safe side.
    mockSessionEndpoint(server, () => new HttpResponse(null, { status: 500 }))

    const { result } = renderHook(() => useIsViewer('p-1'))

    expect(result.current).toBe(false)
    await waitFor(() => expect(result.current).toBe(false))
  })
})
