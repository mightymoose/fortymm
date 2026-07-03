import { useState } from 'react'
import type { NotificationItem } from '@/api/notifications'

/**
 * Tracks the ids of every row that has been unread while the Unread filter is
 * active, so the view can keep showing them after they flip to read.
 *
 * Rows auto-mark-read after a moment on screen (`use-auto-mark-read`), and the
 * optimistic cache write flips their `read_at` in the very feed this page
 * renders. A naive `read_at == null` filter would then drop each row the instant
 * it's read, emptying the Unread list mid-read even though the user never
 * dismissed anything (#762). Pinning the ids lets those rows stay put (they
 * merely lose the unread emphasis) until the user leaves the filter.
 *
 * Leaving the Unread filter (`active` goes false) clears the snapshot, so
 * re-entering starts fresh and rows read in the meantime drop off.
 */
export function useStickyUnread(
  items: NotificationItem[],
  active: boolean,
): ReadonlySet<string> {
  const [pinned, setPinned] = useState<ReadonlySet<string>>(() => new Set())

  // Derive the next snapshot during render (React's recommended alternative to a
  // setState-in-effect): grow it with any currently-unread id while the filter
  // is active, reset it to empty the moment the filter goes inactive. Guarding
  // the setState on an actual change keeps it from looping.
  let next: ReadonlySet<string> = pinned
  if (!active) {
    if (pinned.size > 0) next = new Set()
  } else {
    let grown: Set<string> | null = null
    for (const item of items) {
      if (item.read_at == null && !(grown ?? pinned).has(item.id)) {
        grown ??= new Set(pinned)
        grown.add(item.id)
      }
    }
    if (grown) next = grown
  }
  if (next !== pinned) setPinned(next)

  return next
}
