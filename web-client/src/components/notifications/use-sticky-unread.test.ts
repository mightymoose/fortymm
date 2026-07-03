import { renderHook } from '@/test/utilities'
import { buildNotificationItem } from './notification-row.factory'
import { useStickyUnread } from './use-sticky-unread'

const unread = (id: string) => buildNotificationItem({ id, read_at: null })
const read = (id: string) =>
  buildNotificationItem({ id, read_at: '2026-01-01T00:00:00.000Z' })

describe('useStickyUnread', () => {
  it('pins the currently-unread rows while active', () => {
    const { result } = renderHook(
      ({ items }) => useStickyUnread(items, true),
      { initialProps: { items: [unread('n-1'), read('n-2')] } },
    )
    expect([...result.current]).toEqual(['n-1'])
  })

  it('keeps a row pinned after it flips to read', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useStickyUnread(items, true),
      { initialProps: { items: [unread('n-1')] } },
    )
    expect(result.current.has('n-1')).toBe(true)
    // The row auto-marks-read: same id, now with a read_at.
    rerender({ items: [read('n-1')] })
    expect(result.current.has('n-1')).toBe(true)
  })

  it('accumulates rows that become unread later (e.g. a new arrival)', () => {
    const { result, rerender } = renderHook(
      ({ items }) => useStickyUnread(items, true),
      { initialProps: { items: [unread('n-1')] } },
    )
    rerender({ items: [unread('n-1'), unread('n-2')] })
    expect([...result.current].sort()).toEqual(['n-1', 'n-2'])
  })

  it('clears the snapshot when the filter goes inactive', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useStickyUnread([unread('n-1')], active),
      { initialProps: { active: true } },
    )
    expect(result.current.has('n-1')).toBe(true)
    // Leaving the Unread filter forgets the pinned rows so re-entering is fresh.
    rerender({ active: false })
    expect(result.current.size).toBe(0)
  })

  it('does not pin anything while inactive', () => {
    const { result } = renderHook(() =>
      useStickyUnread([unread('n-1')], false),
    )
    expect(result.current.size).toBe(0)
  })
})
