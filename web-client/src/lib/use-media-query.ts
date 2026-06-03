import { useMemo, useSyncExternalStore } from 'react'

/**
 * Subscribe to a CSS media query and re-render when it starts/stops matching.
 * Used by inline-styled components (e.g. the dashboard) that can't lean on CSS
 * `@media` rules to swap layout. SSR-safe — returns `false` on the server and
 * before hydration, then settles to the real value on mount.
 */
export function useMediaQuery(query: string): boolean {
  // Build the MediaQueryList once per query: React calls getSnapshot on every
  // render, so resolving `window.matchMedia(query)` inline would allocate a
  // fresh list each time.
  const mq = useMemo(() => window.matchMedia(query), [query])
  return useSyncExternalStore(
    (onChange) => {
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => mq.matches,
    () => false,
  )
}
