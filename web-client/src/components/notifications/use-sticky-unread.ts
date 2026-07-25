import { useCallback, useState } from 'react'
import type { NotificationItem } from '@/api/notifications'

const EMPTY: ReadonlySet<string> = new Set()

export interface StickyUnread {
  /** Ids to keep visible on the Unread filter for this visit — the rows that
   * were unread the moment you arrived, even after auto-mark flips them. */
  pinned: ReadonlySet<string>
  /** Drop the whole snapshot — e.g. an explicit "Mark all read" should empty
   * the list rather than leave the just-read rows pinned. */
  forget: () => void
}

/**
 * "Unread" is a per-visit snapshot, not a live `read_at IS NULL` query.
 *
 * Rows auto-mark-read after a moment on screen (`use-auto-mark-read`), and the
 * optimistic cache write flips their `read_at` in the very feed this page
 * renders. On the default **All** filter that happens on arrival, before the
 * user ever clicks Unread — so a naive `read_at == null` filter is empty by the
 * time they get there (#996). Gating the snapshot on the Unread filter being
 * active (the original #762 mechanism) didn't help: nothing was captured while
 * the user sat on All.
 *
 * So we snapshot on **arrival** instead, regardless of the landing filter: the
 * first render where the feed has resolved, we pin exactly the ids that are
 * unread right then. Those rows stay visible under Unread for the whole visit
 * even after auto-mark reads them — "new since you got here." Rows already read
 * on arrival, or created/read on another device mid-visit, are not in the
 * snapshot and correctly don't appear.
 *
 * The snapshot is per mount: a fresh visit (remount) or a reload re-snapshots,
 * and leaving then returning takes a new one. An explicit bulk "Mark all read"
 * (`forget`) clears it so the Unread list actually empties.
 */
export function useStickyUnread(
  items: readonly NotificationItem[] | undefined,
): StickyUnread {
  // `null` means no snapshot taken yet this visit; a set (possibly empty) means
  // it has been captured and must not be recomputed.
  const [snapshot, setSnapshot] = useState<ReadonlySet<string> | null>(null)

  // Snapshot on arrival: the first render where the feed has resolved. This is a
  // state-adjustment during render (the React-recommended alternative to a
  // setState-in-effect) — use the fresh set for this render too, not just next.
  let pinned = snapshot
  if (snapshot === null && items !== undefined) {
    pinned = new Set(
      items.filter((item) => item.read_at == null).map((item) => item.id),
    )
    setSnapshot(pinned)
  }

  // Setting a (non-null) empty set also blocks a re-snapshot for the rest of the
  // visit, so "Mark all read" stays emptied rather than re-capturing next render.
  const forget = useCallback(() => setSnapshot(EMPTY), [])

  return { pinned: pinned ?? EMPTY, forget }
}
