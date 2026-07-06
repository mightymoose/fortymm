import { useRef } from 'react'

/**
 * A one-shot escape hatch for a `useBlocker`'s `shouldBlockFn`/
 * `enableBeforeUnload`: arm it right before an intentional, self-triggered
 * navigation (a save, a finalize, a create) so that hop isn't caught by the
 * same dirty-form guard meant to catch the user leaving by surprise.
 *
 * Backed by a ref, not state: the navigation this unblocks can fire before
 * React re-renders with an updated value, so `shouldBlockFn` must read the
 * live value at call time rather than a snapshot captured when its closure
 * was created — a ref's `.current` does exactly that, regardless of when the
 * closure that reads it was made. See score-entry.tsx (#441) and
 * matches/new.tsx (#75) for the two call sites this generalizes.
 */
export function useNavigationOverrideRef() {
  const armed = useRef(false)
  return {
    isArmed: () => armed.current,
    arm: () => {
      armed.current = true
    },
  }
}
