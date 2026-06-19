import { useCallback, useEffect, useRef } from 'react'
import { useMarkNotificationsRead } from '@/api/notifications'

// How long a row must stop arriving on screen before we flush the batch. Long
// enough to coalesce a scroll/open burst into one request, short enough that the
// badge clears almost immediately after a row settles into view.
const AUTO_MARK_DEBOUNCE_MS = 800

/**
 * Collects the ids of notifications that have come on screen and flushes them to
 * the batch mark-read endpoint once they stop arriving for a short window — so
 * scrolling past (or opening the bell on) a dozen rows fires one request, not a
 * dozen. Returns a `markSeen(id)` callback to hand each row.
 *
 * `mutate` from `useMarkNotificationsRead` is referentially stable, so the
 * returned callback is stable too and won't churn the rows' observers.
 */
export function useAutoMarkRead() {
  const { mutate } = useMarkNotificationsRead()
  const pending = useRef<Set<string>>(new Set())
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    const ids = [...pending.current]
    pending.current.clear()
    if (ids.length > 0) mutate(ids)
  }, [mutate])

  const markSeen = useCallback(
    (id: string) => {
      pending.current.add(id)
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(flush, AUTO_MARK_DEBOUNCE_MS)
    },
    [flush],
  )

  // Flush whatever's still queued when the surface unmounts (the bell closing,
  // a route change) so a final batch isn't dropped on the floor.
  useEffect(() => () => flush(), [flush])

  return markSeen
}
