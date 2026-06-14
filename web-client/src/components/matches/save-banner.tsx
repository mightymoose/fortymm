import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { RotateCw, TriangleAlert, X as XIcon } from 'lucide-react'
import { fireScoreSave } from '@/api/matches'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { useFailedGameSaves } from './score-saves'

export interface SaveBannerProps {
  matchId: string
  /** The game whose entry screen is mounted. Its own failure is omitted — the
   * pre-filled inputs are the retry surface there, so the banner needn't also
   * shout about it. */
  activeGameNumber: number
}

/**
 * Non-blocking failure banner shown under the score-entry header while any of
 * the match's per-game scratch saves are failed. It names the game(s) and
 * offers a retry, but never gates forward navigation — the persistent recovery
 * affordance is each failed scoreline cell (tap to edit, pre-filled).
 *
 * Reads the failed set straight from the shared mutation cache, so it survives
 * the navigation that unmounts the screen that triggered the failure. Retry
 * fires one request per failed game under that game's own mutation key, so two
 * failures send two independent saves and each cell tracks its own outcome.
 *
 * Built on the design-system Alert (it's the app talking back, not a content
 * panel), loss-tinted.
 */
export function SaveBanner({ matchId, activeGameNumber }: SaveBannerProps) {
  const queryClient = useQueryClient()
  const failed = useFailedGameSaves(matchId).filter(
    (entry) => entry.gameNumber !== activeGameNumber,
  )
  // A signature of the current failed set so a dismiss sticks only until the
  // set changes (a new failure, or a retry that clears one) — then it returns.
  const signature = failed.map((entry) => entry.gameNumber).join(',')
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(
    null,
  )

  if (failed.length === 0 || signature === dismissedSignature) return null

  const single = failed.length === 1
  const title = single
    ? `Game ${failed[0].gameNumber} didn't save.`
    : `${failed.length} games didn't save.`
  const description = single
    ? 'Retry now, or tap it in the scoreline to fix the score.'
    : 'Retry all now, or tap a game in the scoreline to fix it.'
  const retryLabel = single ? 'Retry' : 'Retry all'

  function retry() {
    for (const entry of failed) {
      fireScoreSave(queryClient, matchId, entry.gameNumber, entry.variables)
    }
  }

  return (
    <Alert
      variant="destructive"
      className="save-banner mb-4 border-[color:var(--loss)]/45 bg-[color:var(--loss)]/10 has-data-[slot=alert-action]:pr-40"
    >
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-[color:var(--fg-3)]">
        {description}
      </AlertDescription>
      <AlertAction className="top-1/2 flex -translate-y-1/2 items-center gap-1">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
          onClick={retry}
        >
          <RotateCw aria-hidden />
          {retryLabel}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Dismiss"
          className="text-[color:var(--fg-muted)]"
          onClick={() => setDismissedSignature(signature)}
        >
          <XIcon />
        </Button>
      </AlertAction>
    </Alert>
  )
}
