import type { NotificationItem } from '@/api/notifications'
import { act, renderHook } from '@/test/utilities'
import { buildNotificationItem } from './notification-row.factory'
import { useStickyUnread } from './use-sticky-unread'

const READ_AT = '2026-07-03T00:00:00.000Z'

/** Two unread rows and one already-read row, as a fresh feed would arrive. */
function arrivalFeed(): NotificationItem[] {
  return [
    buildNotificationItem({ id: 'n-1', read_at: null }),
    buildNotificationItem({ id: 'n-2', read_at: null }),
    buildNotificationItem({ id: 'n-3', read_at: READ_AT }),
  ]
}

/** The same rows with `ids` flipped read — the optimistic auto-mark cache write. */
function withRead(items: NotificationItem[], ids: string[]): NotificationItem[] {
  return items.map((item) =>
    ids.includes(item.id) ? { ...item, read_at: READ_AT } : item,
  )
}

describe('useStickyUnread', () => {
  it('snapshots the ids that are unread on arrival, ignoring already-read rows', () => {
    const { result } = renderHook(() => useStickyUnread(arrivalFeed()))
    // n-1, n-2 were unread on arrival; n-3 was already read and is not pinned.
    expect([...result.current.pinned].sort()).toEqual(['n-1', 'n-2'])
  })

  it('holds the snapshot after those rows auto-mark-read (the core #996 fix)', () => {
    const items = arrivalFeed()
    const { result, rerender } = renderHook(
      ({ feed }: { feed: NotificationItem[] }) => useStickyUnread(feed),
      { initialProps: { feed: items } },
    )
    // Auto-mark flips both arrival-unread rows to read in the feed cache.
    rerender({ feed: withRead(items, ['n-1', 'n-2']) })
    // They stay pinned — the hook holds ids, not live read state.
    expect([...result.current.pinned].sort()).toEqual(['n-1', 'n-2'])
  })

  it('does not pin rows that arrive unread only mid-visit (another device)', () => {
    const items = arrivalFeed()
    const { result, rerender } = renderHook(
      ({ feed }: { feed: NotificationItem[] }) => useStickyUnread(feed),
      { initialProps: { feed: items } },
    )
    // A brand-new unread row shows up after arrival; it is not "new since you
    // got here" for this snapshot, so it is not pinned.
    rerender({
      feed: [buildNotificationItem({ id: 'n-9', read_at: null }), ...items],
    })
    expect([...result.current.pinned].sort()).toEqual(['n-1', 'n-2'])
  })

  it('takes no snapshot until the feed resolves', () => {
    const { result, rerender } = renderHook(
      ({ feed }: { feed: NotificationItem[] | undefined }) =>
        useStickyUnread(feed),
      { initialProps: { feed: undefined as NotificationItem[] | undefined } },
    )
    expect(result.current.pinned.size).toBe(0)
    rerender({ feed: arrivalFeed() })
    expect([...result.current.pinned].sort()).toEqual(['n-1', 'n-2'])
  })

  it('forgets the whole snapshot on demand (e.g. Mark all read)', () => {
    const items = arrivalFeed()
    const { result } = renderHook(() => useStickyUnread(items))
    act(() => result.current.forget())
    expect(result.current.pinned.size).toBe(0)
  })

  it('stays empty after forget — it does not re-snapshot the same visit', () => {
    const items = arrivalFeed()
    const { result, rerender } = renderHook(
      ({ feed }: { feed: NotificationItem[] }) => useStickyUnread(feed),
      { initialProps: { feed: items } },
    )
    act(() => result.current.forget())
    rerender({ feed: items })
    expect(result.current.pinned.size).toBe(0)
  })

  it('re-snapshots on a fresh visit (remount)', () => {
    const first = renderHook(() => useStickyUnread(arrivalFeed()))
    act(() => first.result.current.forget())
    expect(first.result.current.pinned.size).toBe(0)
    first.unmount()

    // A new mount (return visit / reload) takes a fresh snapshot.
    const second = renderHook(() => useStickyUnread(arrivalFeed()))
    expect([...second.result.current.pinned].sort()).toEqual(['n-1', 'n-2'])
  })
})
