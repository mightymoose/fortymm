import { useCallback, useState } from 'react'

const EMPTY: ReadonlySet<string> = new Set()

export interface StickyUnread {
  /** Ids to keep visible on the Unread filter; empty while the filter is off. */
  pinned: ReadonlySet<string>
  /** Record a row the view just auto-marked-read so it stays put (#762). */
  remember: (id: string) => void
  /** Drop the whole snapshot — e.g. an explicit "Mark all read" should empty
   * the list rather than leave the just-read rows pinned. */
  forget: () => void
}

/**
 * Keeps the rows a user is *actively reading* from vanishing out from under
 * them on the Unread filter.
 *
 * Rows auto-mark-read after a moment on screen (`use-auto-mark-read`), and the
 * optimistic cache write flips their `read_at` in the very feed this page
 * renders. A naive `read_at == null` filter would then drop each row the instant
 * it's read, emptying the Unread list mid-read even though the user never
 * dismissed anything (#762). The view reports each row it auto-marks via
 * `remember`; those ids stay pinned (they merely lose the unread emphasis) until
 * the filter is left or the snapshot is explicitly `forget`-ten.
 *
 * Pinning only what this view auto-read — rather than every row that happens to
 * be unread — is deliberate: a bulk "Mark all read" (`forget`) or a row read on
 * another tab/device is not something the user is mid-reading here, so it drops
 * off the Unread filter as expected instead of lingering.
 *
 * `active` is the Unread filter being on. Entering or leaving it starts a fresh
 * snapshot, so re-entering shows only rows read during this visit.
 */
export function useStickyUnread(active: boolean): StickyUnread {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(EMPTY)
  const [wasActive, setWasActive] = useState(active)

  // Reset on any enter/leave of the filter (state-adjustment during render, the
  // React-recommended alternative to a setState-in-effect). Use the cleared set
  // for this render too, not just the next one.
  let current = pinned
  if (wasActive !== active) {
    setWasActive(active)
    if (pinned.size > 0) {
      current = EMPTY
      setPinned(EMPTY)
    }
  }

  const remember = useCallback((id: string) => {
    setPinned((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
  }, [])

  const forget = useCallback(() => {
    setPinned((prev) => (prev.size === 0 ? prev : EMPTY))
  }, [])

  return { pinned: active ? current : EMPTY, remember, forget }
}
