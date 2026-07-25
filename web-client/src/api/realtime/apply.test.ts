import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { DASHBOARD_QUERY_KEY } from '../dashboard'
import { applyRealtimeEvent } from './apply'
import type { RealtimeEvent } from './events'

function event(kind: RealtimeEvent['kind']): RealtimeEvent {
  return { v: 1, kind, ts: '2026-07-24T18:02:11Z' }
}

describe('applyRealtimeEvent', () => {
  it('invalidates the caches the hint names', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    applyRealtimeEvent(queryClient, event('dashboard.changed'))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: DASHBOARD_QUERY_KEY })
  })

  // The connect-time `resync` is not a special case in the client either: it is
  // the same idempotent refetch, which is precisely what makes a gap during a
  // disconnection self-healing without a replay log or a cursor.
  it('treats resync as an ordinary invalidation', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    applyRealtimeEvent(queryClient, event('resync'))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: DASHBOARD_QUERY_KEY })
  })

  it('handles a kind from a newer server coarsely rather than not at all', () => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    applyRealtimeEvent(queryClient, event('unknown'))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: DASHBOARD_QUERY_KEY })
  })
})
