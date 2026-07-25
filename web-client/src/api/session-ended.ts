import type { SessionEndedInfo } from './client'

/**
 * What losing the session costs, as five separate capabilities.
 *
 * Written as injected actions rather than as a closure over `main.tsx`'s
 * router/queryClient for one reason: the **order** below is a correctness
 * property, and a property nothing can test if it only exists inside the module
 * that also mounts React.
 */
export interface SessionEndedActions {
  /** Stop reading `/v1/stream`. */
  closeRealtime: () => void
  /** Forget that this browser has been into the app (the landing redirect). */
  clearAppEntered: () => void
  /** Drop every cached response — `queryClient.clear()`. */
  clearQueryCache: () => void
  /** Tell the user why they are being sent to sign in. */
  notify: (message: string) => void
  /** Go to `/login`, with the owning account's email prefilled when we have it. */
  navigateToLogin: (email: string | undefined) => void
}

/**
 * React to a session-ended 401 — merged away on another device
 * (`session_merged`), or signed out / expired (`session_ended`).
 *
 * **The order is the point.**
 *
 * 1. `closeRealtime()` FIRST. `clearQueryCache()` is synchronous but the
 *    navigation after it is not, so between the two there is a real window in
 *    which this tab is still running. A stream left open across that window can
 *    deliver a hint, the hint invalidates a query, and the invalidation refetches
 *    — repopulating the cache that was just emptied, with the departed user's
 *    data, for whoever signs in next. Closing the stream first removes the only
 *    thing that can write during the gap.
 * 2. `clearQueryCache()`, not a targeted `removeQueries(['session'])`: this is an
 *    identity-loss event, so ALL per-user data goes (dashboard, matches,
 *    players, …), the same way `useLogout`/`useConsumeLoginToken` do it —
 *    otherwise a browser that re-enters as a fresh guest inherits the previous
 *    holder's BFF responses until they happen to go stale (#754).
 * 3. Only then say so and leave.
 */
export function handleSessionEnded(
  actions: SessionEndedActions,
  info: SessionEndedInfo,
): void {
  actions.closeRealtime()
  actions.clearAppEntered()
  actions.clearQueryCache()
  actions.notify(info.message)
  actions.navigateToLogin(info.email)
}
