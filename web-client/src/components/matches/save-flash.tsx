import { useEffect } from 'react'
import { TriangleAlert, X as XIcon } from 'lucide-react'

export interface SaveFlashProps {
  /** The game whose save failed — named in the banner copy. */
  gameNumber: number
  /** Fired on the ✕ click and again automatically after 6 seconds. */
  onDismiss: () => void
}

/** How long the flash stays up before dismissing itself. */
export const SAVE_FLASH_DURATION_MS = 6000

/**
 * Transient "Game N didn't save" banner shown under the score-entry header
 * after a per-game save fails. Non-blocking by design: it names the game,
 * points at the scoreline (where the failed cell is the actual retry
 * affordance), and auto-dismisses — it never gates "Save game & next".
 * Remount (key by flash id) to restart the timer for a repeat failure.
 */
export const SaveFlash = ({ gameNumber, onDismiss }: SaveFlashProps) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, SAVE_FLASH_DURATION_MS)
    return () => clearTimeout(timer)
    // Mount-only: the timer belongs to this flash instance, not to renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="save-flash" role="alert">
      <span className="save-flash__icon" aria-hidden="true">
        <TriangleAlert size={18} strokeWidth={1.75} />
      </span>
      <div className="save-flash__text">
        <p className="save-flash__title">Game {gameNumber} didn't save.</p>
        <p className="save-flash__hint">Tap it in the scoreline to retry.</p>
      </div>
      <button
        type="button"
        className="save-flash__close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <XIcon size={16} strokeWidth={2} aria-hidden />
      </button>
      <span className="save-flash__timer" aria-hidden="true" />
    </div>
  )
}
