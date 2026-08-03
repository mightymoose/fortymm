// **A refusal expires.** It is a statement about a *moment* — the server was asked, in a
// state, and said no about that state. It is never wrong when it is produced, and it stops
// being true the instant the state it describes changes (`CONTEXT.md`, "Refusal"). Once the
// director adds the event that was missing, or the entrant arrives that made the pools
// legal, or the draw type changes under the plan, the sentence on screen is no longer a
// refusal — it is a leftover, contradicting the page it sits on.
//
// So a notice is not stored on its own. It is stored **with a fingerprint of the state it
// turns on**, and shown only while that fingerprint still matches. This module is the one
// place that rule lives: the surfaces that report refusals inline (the header's lifecycle
// alert, the draw panel) adopt it in a line, rather than each
// rediscovering when to clear a banner.
//
// ## Why a fingerprint, and not the two things we tried first
//
// - **Not "clear it whenever fresh server data arrives."** Too coarse. The tournament
//   refetches on every settle of every mutation, so renaming an event in another tab would
//   withdraw a still-perfectly-true work list — and that list ("“Open Singles” has no draw
//   yet; and “Over 40s” has a draw that no longer matches its entrants") is exactly what
//   the director is reading *while* going to fix it (ADR-0786). Taking it away mid-fix is
//   worse than leaving it up.
// - **Not a hand-maintained `useEffect` dependency list per surface.** It works once and
//   then rots: the next refusal added to a surface is one forgotten dependency away from
//   reintroducing the stale banner, and nothing fails when it is forgotten.
//
// The fingerprint is instead a small value the surface derives from the fields *its*
// refusal turns on (an event count, a draw type, an entrant count). It sits next to the
// state it summarises, in the surface that knows what the refusal was about.
//
// ## It is a render-time concern
//
// An expired notice **is simply not shown**. No timer, no subscription, no query
// invalidation — nothing to schedule, and nothing that can fire after the component has
// gone. The withdrawal happens in the same render that first sees the new state.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { Notice } from './notice'

/**
 * A summary of the state a refusal turns on — opaque by design. Nothing reads *into* one;
 * the only question ever asked of it is "is it still the same one?", so any encoding works
 * as long as different states encode differently.
 */
export type NoticeFingerprint = string

/** What a fingerprint may be built from: the primitives a refusal actually turns on. Not
 * objects — an object would invite fingerprinting a whole payload, which is the coarse
 * "clear on any refetch" rule wearing a disguise. */
export type FingerprintPart = string | number | boolean | null | undefined

/**
 * Build a fingerprint from the fields a refusal depends on:
 *
 * ```ts
 * const fingerprint = noticeFingerprint(event.drawType, event.entrants.length)
 * ```
 *
 * The parts are encoded, not concatenated, so a boundary between two of them cannot be
 * lost: `noticeFingerprint('a', 'b')` and `noticeFingerprint('ab')` are different
 * fingerprints, where `'a' + 'b'` and `'ab'` would not be. (`null` and `undefined` do
 * collapse together — both mean "absent", and no refusal turns on telling them apart.)
 */
export function noticeFingerprint(
  ...parts: FingerprintPart[]
): NoticeFingerprint {
  return JSON.stringify(parts)
}

/**
 * A **set** of ids as one fingerprint part — de-duplicated, **sorted**, with `null`s
 * dropped.
 *
 * Here rather than in a surface file because two of those three steps are load-bearing
 * and only one is obvious, and getting them wrong fails in the expensive direction:
 *
 * - **Sorted**, so the server returning the same ids in a different order is not
 *   mistaken for a state change. A surface that forgets this withdraws a refusal that
 *   is still perfectly true, which is the failure mode this whole module exists to
 *   avoid — worse than the staleness it was fixing.
 * - **De-duplicated**, so the part describes membership rather than multiplicity.
 * - **`null`s dropped**, because an absent id is not a member.
 *
 * Reach for this when the refusal turns on *which* things are there — a set comparison,
 * the way the go-live precondition compares entrants against the entries its fixtures
 * seat. When it turns only on *how many*, pass the count as a plain part instead: a set
 * would then withdraw a still-true refusal the moment one member was swapped for
 * another, which is exactly the distinction the two adopting surfaces make differently
 * and on purpose.
 */
export function fingerprintSet(ids: (string | null)[]): FingerprintPart {
  return noticeFingerprint(...[...new Set(ids.filter((id) => id !== null))].sort())
}

/** A notice and the state it was produced about — the pair, never one without the other. */
interface HeldNotice<T extends Notice> {
  notice: T
  fingerprint: NoticeFingerprint
}

/**
 * Hold a refusal for exactly as long as it is still true.
 *
 * Drop-in for the `useState<Notice | null>` a surface would otherwise write — same tuple,
 * same `null` to clear — except that it takes **the fingerprint of the state the refusal
 * turns on**:
 *
 * ```tsx
 * const [refusal, setRefusal] = useExpiringNotice<LifecycleRefusal>(
 *   noticeFingerprint(tournament.status, tournament.events.length),
 * )
 * ```
 *
 * The setter takes only the notice: **a caller cannot store one and forget to stamp it**,
 * because the stamp is not theirs to pass. That is the whole reason this is a hook and not
 * a `{ notice, fingerprint }` object the surface assembles itself.
 *
 * Two details that are load-bearing:
 *
 * - **The stamp is read when the notice is stored, not when the handler was created.** A
 *   refusal arrives from an `await mutateAsync(...)` that rejects, and these mutations
 *   reconcile the tournament `onSettled` — on the *failure* path too (`./api`) — so fresh
 *   data can land, and the component re-render, between the click and the rejection. A
 *   fingerprint captured in the handler's closure would be the one from the render that
 *   built the handler, and a refusal stamped with it would be born expired and never shown
 *   at all. Hence the ref: the notice is stamped with the freshest state we know at the
 *   moment the server answered.
 * - **Withdrawn is permanent.** Once the state moves on, the notice is dropped, not merely
 *   hidden — a fingerprint that happens to come back around (an entrant joins, then leaves)
 *   must not resurrect a banner nobody re-asked for. A refusal stopped being true; it does
 *   not un-stop.
 *
 * @param fingerprint the current state, per `noticeFingerprint`
 * @returns `[notice, show]` — `notice` is `null` once expired; `show(null)` clears it
 *   explicitly, which is what a surface does when a new attempt starts.
 */
export function useExpiringNotice<T extends Notice = Notice>(
  fingerprint: NoticeFingerprint,
): readonly [T | null, (notice: T | null) => void] {
  const [held, setHeld] = useState<HeldNotice<T> | null>(null)

  // The state on screen NOW, readable from an async handler that resolves several renders
  // after the click that started it. Written in an effect (a ref must not be touched
  // during render), which is after the commit and therefore before any handler can run.
  const current = useRef(fingerprint)
  useEffect(() => {
    current.current = fingerprint
  }, [fingerprint])

  const show = useCallback((notice: T | null) => {
    setHeld(notice === null ? null : { notice, fingerprint: current.current })
  }, [])

  // The expiry check, at render time. The `setHeld` is React's own "adjust state when the
  // props change" — it re-runs this component before committing anything, so the expired
  // notice is never painted, and dropping it is what makes the withdrawal permanent.
  const expired = held !== null && held.fingerprint !== fingerprint
  if (expired) setHeld(null)

  return [expired || held === null ? null : held.notice, show]
}
