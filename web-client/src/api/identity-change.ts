/**
 * The identity behind this tab is changing.
 *
 * Three paths reach here, and they are the same event wearing different clothes:
 *
 * - a **deliberate sign-out** (`useLogout`),
 * - a **sign-in that lands on a different account** (`useConfirmEmail` /
 *   `useConsumeLoginToken` with `skip_merge`),
 * - the server saying the **session is gone** — merged away on another device
 *   (`session_merged`) or signed out / expired (`session_ended`), surfaced as a
 *   401 by the response middleware in `./client`.
 *
 * They share one hazard, so they share one function: see the ordering note on
 * `handleIdentityChange`. A path that spelled the steps out inline would look
 * correct and be wrong, which is exactly how the sign-out path drifted the
 * first time.
 */

/**
 * What an identity change costs, as separate capabilities.
 *
 * Written as injected actions rather than as a closure over `main.tsx`'s
 * router/queryClient for one reason: the **order** below is a correctness
 * property, and a property nothing can test if it only exists inside the module
 * that also mounts React.
 *
 * The first two are required — they are the ordered pair this module exists
 * for. The rest are optional because they belong to only *some* of the paths: a
 * deliberate sign-out owns its own navigation and needs no toast explaining
 * itself, and a sign-in must not forget that this browser has been into the app.
 */
export interface IdentityChangeActions {
  /** Stop reading `/v1/stream`. */
  closeRealtime: () => void
  /** Drop every cached response — `queryClient.clear()`. */
  clearQueryCache: () => void
  /**
   * Forget that this browser has been into the app (the landing redirect).
   * Omitted by the paths that are signing someone straight back *in*.
   */
  clearAppEntered?: () => void
  /** Tell the user why. Omitted when they already know — they just clicked it. */
  notify?: (message: string) => void
  /**
   * Go to `/login`, with the owning account's email prefilled when we have it.
   * Omitted where the caller owns the navigation that follows.
   */
  navigateToLogin?: (email: string | undefined) => void
}

/** What we know about the change — only the 401 path knows anything. */
export interface IdentityChangeInfo {
  /** The reason to show the user. Absent when they asked for this. */
  message?: string
  /** The owning account's email, to prefill sign-in. */
  email?: string
}

/**
 * Tear down the departing identity, in the one order that is safe.
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
 *    players, …) — otherwise a browser that re-enters as a fresh guest inherits
 *    the previous holder's BFF responses until they happen to go stale (#754).
 * 3. Only then say so and leave.
 */
export function handleIdentityChange(
  actions: IdentityChangeActions,
  info: IdentityChangeInfo = {},
): void {
  actions.closeRealtime()
  actions.clearAppEntered?.()
  actions.clearQueryCache()
  if (info.message !== undefined) actions.notify?.(info.message)
  actions.navigateToLogin?.(info.email)
}
