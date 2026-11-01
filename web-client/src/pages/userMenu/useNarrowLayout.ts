import { useSyncExternalStore } from 'react'

// The width below which the app shell's sidebar becomes a tab bar, as in
// `.app-shell`'s media query in styles/base.css.
const NARROW = '(max-width: 899px)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(NARROW)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

// jsdom has no matchMedia, so a test without a stub gets the wide layout.
const isNarrow = () => window.matchMedia?.(NARROW).matches ?? false

export function useNarrowLayout(): boolean {
  return useSyncExternalStore(subscribe, isNarrow)
}
