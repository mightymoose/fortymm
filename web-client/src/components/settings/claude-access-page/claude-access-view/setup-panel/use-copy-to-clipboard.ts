import { useCallback, useEffect, useState } from 'react'

/** Which of the panel's two fields a copy attempt was about. */
export type CopyFieldId = 'url' | 'clientId'

/**
 * The last copy attempt, and how it went. **One at a time, by construction** —
 * copying the second field replaces this rather than adding to it, so the
 * `COPIED` marker moves instead of lighting up both fields at once (which would
 * leave a player unable to tell what is actually on their clipboard).
 */
export interface CopyOutcome {
  field: CopyFieldId
  /** Whether the value actually reached the clipboard. */
  ok: boolean
}

/** How long a `COPIED` marker stays up: long enough to read, short enough that
 * it never reads as permanent state. */
export const COPIED_MARKER_MS = 2400

/**
 * Write to the clipboard, without ever throwing.
 *
 * Two ordinary conditions break the Clipboard API on a page whose entire job is
 * to hand a player two strings:
 *
 * 1. **It isn't there.** `navigator.clipboard` is undefined outside a secure
 *    context (plain `http://` on anything but localhost) and in older browsers.
 * 2. **It refuses.** `writeText` *rejects* when the document isn't focused or
 *    the permission is denied.
 *
 * An unhandled rejection here would take down a page a player is mid-setup on,
 * so both collapse to `false` and the caller says so out loud instead.
 */
async function writeToClipboard(value: string): Promise<boolean> {
  try {
    const clipboard: Clipboard | undefined = navigator.clipboard
    if (typeof clipboard?.writeText !== 'function') return false
    await clipboard.writeText(value)
    return true
  } catch {
    return false
  }
}

/** What `useCopyToClipboard` hands its panel. */
export interface CopyToClipboard {
  /** The last attempt, or `null` when there has been none — or when a
   * successful marker has since timed out. */
  outcome: CopyOutcome | null
  /** Copy `value`, attributing the result to `field`. */
  copy: (field: CopyFieldId, value: string) => void
}

/**
 * The copy-button state for a panel: one outcome, held briefly.
 *
 * A **success** expires on its own after {@link COPIED_MARKER_MS}. A
 * **failure** does not: it carries an instruction ("select the value and copy
 * it yourself") that a player has to be able to finish reading and act on, and
 * it stands until the next attempt replaces it.
 *
 * Each attempt stores a *fresh* object even when nothing about it changed, so
 * copying the same field twice restarts the countdown rather than riding out
 * the first one.
 */
export function useCopyToClipboard(): CopyToClipboard {
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null)

  useEffect(() => {
    if (outcome === null || !outcome.ok) return
    const timer = window.setTimeout(() => setOutcome(null), COPIED_MARKER_MS)
    return () => window.clearTimeout(timer)
  }, [outcome])

  const copy = useCallback((field: CopyFieldId, value: string) => {
    void writeToClipboard(value).then((ok) => setOutcome({ field, ok }))
  }, [])

  return { outcome, copy }
}
