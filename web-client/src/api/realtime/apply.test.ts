import { QueryClient } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'
import { DASHBOARD_QUERY_KEY } from '../dashboard'
import { applyRealtimeEvent } from './apply'
import type { RealtimeEvent } from './events'

function event(kind: RealtimeEvent['kind']): RealtimeEvent {
  return { v: 1, kind, ts: '2026-07-24T18:02:11Z' }
}

describe('applyRealtimeEvent', () => {
  // All three kinds are the SAME idempotent refetch, and that sameness is the
  // design rather than an accident worth three bodies: the connect-time
  // `resync` is what makes a gap during a disconnection self-heal without a
  // replay log or a cursor, and a kind from a newer server is handled coarsely
  // rather than not at all.
  it.each<[RealtimeEvent['kind']]>([
    ['dashboard.changed'],
    ['resync'],
    ['unknown'],
  ])('invalidates the caches %s names', (kind) => {
    const queryClient = new QueryClient()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    applyRealtimeEvent(queryClient, event(kind))

    expect(invalidate).toHaveBeenCalledWith({ queryKey: DASHBOARD_QUERY_KEY })
  })
})
