import { useEffect } from 'react'
import { TriangleAlert, X as XIcon } from 'lucide-react'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

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
 * Built on the design-system Alert (it's the app talking back, not a
 * content panel), loss-tinted, with the AlertAction slot for the dismiss
 * control. Remount (key by flash id) to restart the timer for a repeat
 * failure.
 */
export const SaveFlash = ({ gameNumber, onDismiss }: SaveFlashProps) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, SAVE_FLASH_DURATION_MS)
    return () => clearTimeout(timer)
    // Mount-only: the timer belongs to this flash instance, not to renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <Alert
      variant="destructive"
      className="save-flash mb-4 border-[color:var(--loss)]/45 bg-[color:var(--loss)]/10"
    >
      <TriangleAlert aria-hidden />
      <AlertTitle>Game {gameNumber} didn't save.</AlertTitle>
      <AlertDescription className="text-[color:var(--fg-3)]">
        Tap it in the scoreline to retry.
      </AlertDescription>
      <AlertAction className="top-1/2 -translate-y-1/2">
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          className="text-[color:var(--fg-muted)]"
          onClick={onDismiss}
        >
          <XIcon />
        </Button>
      </AlertAction>
      <span className="save-flash__timer" aria-hidden="true" />
    </Alert>
  )
}
