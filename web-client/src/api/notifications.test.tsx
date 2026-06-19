import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'

import { server } from '@/mocks/server'
import {
  NOTIFICATIONS_QUERY_KEY,
  type NotificationFeed,
  type UnreadCount,
  useMarkNotificationsRead,
} from './notifications'

const feedKey = [...NOTIFICATIONS_QUERY_KEY, 'feed']
const countKey = [...NOTIFICATIONS_QUERY_KEY, 'unread-count']

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function seedFeed(): NotificationFeed {
  return {
    items: [
      buildItem('a', null),
      buildItem('b', null),
      buildItem('c', '2026-06-17T10:00:00.000Z'),
    ],
    unread_count: 2,
  }
}

function buildItem(id: string, read_at: string | null): NotificationFeed['items'][number] {
  return {
    id,
    category: 'tournament',
    title: id,
    body: id,
    link: null,
    action_label: null,
    delta: null,
    read_at,
    created_at: '2026-06-17T09:00:00.000Z',
  }
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  queryClient.setQueryData<NotificationFeed>(feedKey, seedFeed())
  queryClient.setQueryData<UnreadCount>(countKey, { unread_count: 2 })
})

afterEach(() => {
  queryClient.clear()
})

describe('useMarkNotificationsRead', () => {
  it('optimistically clears the seen rows and drops the unread count', async () => {
    // The server agrees one row flipped, and the re-read reflects the new truth,
    // so the optimistic state and the reconciled state line up.
    server.use(
      http.post('*/v1/notifications/read', () =>
        HttpResponse.json({ marked: 1 }),
      ),
      http.get('*/v1/notifications', () =>
        HttpResponse.json({
          items: [
            buildItem('a', '2026-06-17T12:00:00.000Z'),
            buildItem('b', null),
            buildItem('c', '2026-06-17T10:00:00.000Z'),
          ],
          unread_count: 1,
        }),
      ),
      http.get('*/v1/notifications/unread-count', () =>
        HttpResponse.json({ unread_count: 1 }),
      ),
    )

    const { result } = renderHook(() => useMarkNotificationsRead(), { wrapper })
    result.current.mutate(['a'])

    await waitFor(() => {
      const feed = queryClient.getQueryData<NotificationFeed>(feedKey)
      expect(feed?.items.find((n) => n.id === 'a')?.read_at).not.toBeNull()
      expect(feed?.unread_count).toBe(1)
      expect(queryClient.getQueryData<UnreadCount>(countKey)?.unread_count).toBe(1)
    })
  })

  it('rolls the count back to server truth when the batch request fails', async () => {
    server.use(
      http.post('*/v1/notifications/read', () =>
        HttpResponse.json({ detail: 'boom' }, { status: 500 }),
      ),
      // On settle the failed mutation re-reads, which restores the unread feed.
      http.get('*/v1/notifications', () => HttpResponse.json(seedFeed())),
      http.get('*/v1/notifications/unread-count', () =>
        HttpResponse.json({ unread_count: 2 }),
      ),
    )

    const { result } = renderHook(() => useMarkNotificationsRead(), { wrapper })
    result.current.mutate(['a'])

    await waitFor(() => expect(result.current.isError).toBe(true))
    await waitFor(() => {
      expect(queryClient.getQueryData<UnreadCount>(countKey)?.unread_count).toBe(2)
      const feed = queryClient.getQueryData<NotificationFeed>(feedKey)
      expect(feed?.items.find((n) => n.id === 'a')?.read_at).toBeNull()
    })
  })
})
