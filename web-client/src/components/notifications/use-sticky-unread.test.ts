import { act, renderHook } from '@/test/utilities'
import { useStickyUnread } from './use-sticky-unread'

describe('useStickyUnread', () => {
  it('pins ids reported via remember while active', () => {
    const { result } = renderHook(() => useStickyUnread(true))
    act(() => result.current.remember('n-1'))
    expect([...result.current.pinned]).toEqual(['n-1'])
  })

  it('keeps a pinned id even after the row it names flips to read', () => {
    // The hook holds ids, not read state — so a row stays pinned through its
    // optimistic read_at flip. (The view test asserts the visible effect.)
    const { result } = renderHook(() => useStickyUnread(true))
    act(() => result.current.remember('n-1'))
    act(() => result.current.remember('n-1'))
    expect([...result.current.pinned]).toEqual(['n-1'])
  })

  it('exposes no pins while inactive, even after remember', () => {
    const { result } = renderHook(({ active }) => useStickyUnread(active), {
      initialProps: { active: false },
    })
    act(() => result.current.remember('n-1'))
    expect(result.current.pinned.size).toBe(0)
  })

  it('forgets the whole snapshot on demand (e.g. Mark all read)', () => {
    const { result } = renderHook(() => useStickyUnread(true))
    act(() => result.current.remember('n-1'))
    act(() => result.current.forget())
    expect(result.current.pinned.size).toBe(0)
  })

  it('starts fresh on re-entry: leaving and returning drops earlier pins', () => {
    const { result, rerender } = renderHook(
      ({ active }) => useStickyUnread(active),
      { initialProps: { active: true } },
    )
    act(() => result.current.remember('n-1'))
    expect(result.current.pinned.has('n-1')).toBe(true)

    // Leave the Unread filter...
    rerender({ active: false })
    expect(result.current.pinned.size).toBe(0)

    // ...and come back: n-1 (read in the meantime) is no longer pinned, so it
    // drops off instead of being resurrected.
    rerender({ active: true })
    expect(result.current.pinned.size).toBe(0)
  })
})
