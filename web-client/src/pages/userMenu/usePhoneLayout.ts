import { useSyncExternalStore } from 'react'

// Phone widths, where the topbar hides the player's name, as in
// `.user-menu__name`'s media query in styles/base.css. A tablet or a desktop
// can't install a phone beta.
const PHONE = '(max-width: 599px)'

function subscribe(onChange: () => void) {
  const query = window.matchMedia?.(PHONE)
  query?.addEventListener('change', onChange)
  return () => query?.removeEventListener('change', onChange)
}

// jsdom has no matchMedia, so a test without a stub gets the wide layout.
const isPhone = () => window.matchMedia?.(PHONE).matches ?? false

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(subscribe, isPhone)
}
