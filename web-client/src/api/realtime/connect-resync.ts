import type { RealtimeEvent } from './events'

/**
 * The one hint a caller that has *just fetched* should swallow: the
 * connect-time `resync`.
 *
 * The server opens **every** stream with a `resync`, and answers a pub/sub
 * recovery with another one. Both mean the same thing — "you may have missed
 * something, reconcile" — and reconciling is a refetch (`./invalidation`). That
 * is right in general, and redundant in exactly one case: the *first* one, on
 * the connection a page load opened, because the page load has already fetched.
 * Honouring it made loading `/dashboard` cost two `/v1/dashboard` reads instead
 * of one, on every load, for every connected user.
 *
 * ## What it keys on: the RUN, not the connection attempt
 *
 * This is the part that goes wrong in either direction, so it is worth being
 * exact. `openRealtimeConnection` is a *loop*: one call keeps reconnecting
 * across drops and across the server's ~15-minute scheduled hang-up. There are
 * therefore two candidate scopes, and they disagree:
 *
 * - **Per connection attempt** (reset the flag on every reconnect) would
 *   suppress the resync that follows the 15-minute recycle — the one reconnect
 *   that is *not* accompanied by a fresh fetch. The client would come back from
 *   a gap and never reconcile it: a permanently stale dashboard, and the exact
 *   failure the `resync` exists to prevent.
 * - **Per run** — one filter per `openRealtimeConnection` call, i.e. per
 *   `RealtimeProvider` mount — suppresses only the resync of the connection that
 *   the mount itself opened. That mount is the page load, and the page load
 *   fetched. Every later resync, from a recycle or a recovery, is honoured.
 *
 * So: per run. The distinguishing signal is not "is this a reconnect?" — the
 * client cannot tell a recycle from a genuine drop, and does not need to — it is
 * **"has this run already delivered an event?"**. Only a run's first event can
 * be the one whose fetch the mount already did.
 *
 * ## Only the first, and only if it is a `resync`
 *
 * A `dashboard.changed` is never suppressed, first event or not: it reports a
 * change that happened *after* the fetch, so dropping it would lose it outright.
 * The flag is spent by the first event whatever its kind, which is what keeps
 * "the first event" from drifting into "the first resync, whenever it turns up".
 *
 * ## Relationship to iOS
 *
 * Same rule, same scope, arrived at from a different lifecycle. iOS scopes its
 * `awaitingConnectResync` to a `RealtimeConnection.run`, whose lifetime is "the
 * dashboard tab is in front" — and coming to the front is what refetches there
 * (`refetchOnForeground` / `refetchWhenSelected`, see `ViewModifiers.swift`).
 * On web the run's lifetime is the authenticated route boundary: the provider
 * mounts once in `routes/_app/route.tsx` and the connection recycles many times
 * underneath it. Both reduce to "the run began with a fetch", so the semantics
 * transfer unchanged — only the event that starts a run differs.
 *
 * Deliberately a factory over a closure rather than a flag inside
 * `./connection`: whether a connect-time resync is redundant is a fact about the
 * *caller* (it has just fetched), not about the wire. The connection stays a
 * faithful transport that delivers every event it decodes — as iOS's does.
 */

/** Answers "should this hint be applied?" — stateful, one per run. */
export type RealtimeHintFilter = (event: RealtimeEvent) => boolean

/**
 * A filter for one run: drops the run's first event if it is a `resync`, and
 * passes everything else.
 *
 * Create it **inside** the effect that opens the connection, so a remount gets a
 * fresh one and a reconnect does not.
 */
export function createConnectResyncFilter(): RealtimeHintFilter {
  let awaitingConnectResync = true
  return (event) => {
    const isConnectResync = awaitingConnectResync && event.kind === 'resync'
    awaitingConnectResync = false
    return !isConnectResync
  }
}
