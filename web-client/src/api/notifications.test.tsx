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
  useUnreadCount,
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

  it('reconciles the badge to server truth when the optimistic decrement is a no-op', async () => {
    // #1112: the debounced batch flushes ids that aren't in the on-screen feed
    // (e.g. rows already scrolled past / not held in this cache), so the
    // optimistic pass finds newlyRead == 0 and cannot drop the badge. The badge
    // must still converge to the server's true count promptly — not stick stale
    // until the 60s poll. The server reports 2 unread until the batch read lands,
    // then 1; only a post-success reconcile of the count query surfaces that.
    let read = false
    server.use(
      http.post('*/v1/notifications/read', () => {
        read = true
        return HttpResponse.json({ marked: 1 })
      }),
      http.get('*/v1/notifications/unread-count', () =>
        HttpResponse.json({ unread_count: read ? 1 : 2 }),
      ),
    )

    const { result } = renderHook(
      () => ({
        badge: useUnreadCount(),
        markRead: useMarkNotificationsRead(),
      }),
      { wrapper },
    )

    // The mounted badge settles on the initial server truth (2).
    await waitFor(() =>
      expect(result.current.badge.data?.unread_count).toBe(2),
    )

    // Flush a batch whose ids aren't in the feed: the optimistic decrement is a
    // no-op, so without a reconcile the badge would stay at 2 until the poll.
    result.current.markRead.mutate(['not-in-feed'])

    await waitFor(() =>
      expect(result.current.badge.data?.unread_count).toBe(1),
    )
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
