import { useEffect, useRef } from 'react'

// Fire once an element is at least half visible.
const SEEN_THRESHOLD = 0.5

/**
 * Returns a ref to attach to an element; calls `onSeen` once — the first time
 * the element crosses into view — but only while `active`. Inert in environments
 * without IntersectionObserver (jsdom in unit tests). Keeps the latest `onSeen`
 * in a ref so an inline arrow from the caller doesn't re-subscribe the observer
 * on every render; it only re-subscribes when `active` flips.
 */
export function useSeenOnScreen<T extends Element>(
  active: boolean,
  onSeen: () => void,
) {
  const ref = useRef<T>(null)
  const onSeenRef = useRef(onSeen)
  useEffect(() => {
    onSeenRef.current = onSeen
  })

  useEffect(() => {
    if (!active || typeof IntersectionObserver === 'undefined') return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          onSeenRef.current()
          observer.disconnect() // fire once
        }
      },
      { threshold: SEEN_THRESHOLD },
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [active])

  return ref
}
