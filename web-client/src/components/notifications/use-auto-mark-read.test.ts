import { act, renderHook } from '@/test/utilities'

const { mutateMock } = vi.hoisted(() => ({ mutateMock: vi.fn() }))

vi.mock('@/api/notifications', () => ({
  useMarkNotificationsRead: () => ({ mutate: mutateMock }),
}))

// Imported after the mock is declared (vi.mock hoists above all imports).
import { useAutoMarkRead } from './use-auto-mark-read'

describe('useAutoMarkRead', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mutateMock.mockClear()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('coalesces several seen rows into one batched call after the debounce', () => {
    const { result } = renderHook(() => useAutoMarkRead())

    act(() => {
      result.current('a')
      result.current('b')
      result.current('c')
    })
    // Nothing fires until the burst stops arriving.
    expect(mutateMock).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(800))

    expect(mutateMock).toHaveBeenCalledTimes(1)
    expect(mutateMock).toHaveBeenCalledWith(['a', 'b', 'c'])
  })

  it('keeps deferring the flush while rows keep arriving', () => {
    const { result } = renderHook(() => useAutoMarkRead())

    act(() => result.current('a'))
    act(() => vi.advanceTimersByTime(500))
    act(() => result.current('b')) // resets the window
    act(() => vi.advanceTimersByTime(500))
    expect(mutateMock).not.toHaveBeenCalled()

    act(() => vi.advanceTimersByTime(300))
    expect(mutateMock).toHaveBeenCalledWith(['a', 'b'])
  })

  it('dedupes a repeated id within a batch', () => {
    const { result } = renderHook(() => useAutoMarkRead())

    act(() => {
      result.current('a')
      result.current('a')
    })
    act(() => vi.advanceTimersByTime(800))

    expect(mutateMock).toHaveBeenCalledWith(['a'])
  })

  it('starts a fresh batch after a flush', () => {
    const { result } = renderHook(() => useAutoMarkRead())

    act(() => result.current('a'))
    act(() => vi.advanceTimersByTime(800))
    act(() => result.current('b'))
    act(() => vi.advanceTimersByTime(800))

    expect(mutateMock).toHaveBeenNthCalledWith(1, ['a'])
    expect(mutateMock).toHaveBeenNthCalledWith(2, ['b'])
  })

  it('flushes a still-pending batch on unmount', () => {
    const { result, unmount } = renderHook(() => useAutoMarkRead())

    act(() => result.current('a'))
    unmount()

    expect(mutateMock).toHaveBeenCalledWith(['a'])
  })

  it('does not fire an empty batch on unmount', () => {
    const { unmount } = renderHook(() => useAutoMarkRead())
    unmount()
    expect(mutateMock).not.toHaveBeenCalled()
  })
})
