import { useEffect, useRef } from 'react'

// Fire once an element is at least half visible.
const SEEN_THRESHOLD = 0.5

/**
 * Returns a ref to attach to an element; calls `onSeen` exactly once — the first
 * time the element crosses into view, ever, for this mounted instance — but only
 * while `active`. Inert in environments without IntersectionObserver (jsdom in
 * unit tests). Keeps the latest `onSeen` in a ref so an inline arrow from the
 * caller doesn't re-subscribe the observer on every render; it only re-subscribes
 * when `active` flips.
 *
 * The once-ever guard matters because `active` can flip false→true again: an
 * optimistic mark-read that the server later rejects rolls the row back to
 * unread, which would otherwise re-arm the observer on a still-visible row and
 * re-fire `onSeen` — an ~debounce-period retry loop against a failing endpoint.
 * Once reported, we stay quiet until the row remounts.
 */
export function useSeenOnScreen<T extends Element>(
  active: boolean,
  onSeen: () => void,
) {
  const ref = useRef<T>(null)
  const onSeenRef = useRef(onSeen)
  const reported = useRef(false)
  useEffect(() => {
    onSeenRef.current = onSeen
  })

  useEffect(() => {
    if (!active || reported.current || typeof IntersectionObserver === 'undefined')
      return
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          reported.current = true
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
