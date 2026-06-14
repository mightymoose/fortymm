import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { RotateCw, TriangleAlert, X as XIcon } from 'lucide-react'
import { ApiError } from '@/api/client'
import {
  fireScoreSave,
  matchDetailRoute,
  useFinalizeMatch,
  useMatch,
} from '@/api/matches'
import { decidedSide, type GamePoints } from '@/lib/scoring'
import { cn } from '@/lib/utils'
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
  /** The game whose entry screen is mounted. Its own failure is normally
   * omitted — the pre-filled inputs are the retry surface there, so the banner
   * needn't also shout about it. The exception is when that game's score
   * finishes the match: we stay on it, the banner surfaces (informational
   * only), and the main "Post result" button owns finalizing. */
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
  const navigate = useNavigate()
  const { data } = useMatch(matchId)
  const finalizeMutation = useFinalizeMatch(matchId)
  const allFailed = useFailedGameSaves(matchId)
  const otherFailed = allFailed.filter(
    (entry) => entry.gameNumber !== activeGameNumber,
  )
  // A dismiss sticks only until the failed set changes (a new failure, or a
  // retry that clears one) — keyed by the signature computed below.
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(
    null,
  )

  // Nothing failed → nothing to show; skip the merge/finalize work below.
  if (allFailed.length === 0) return null

  // The recorded scores behind these failures (failed scratch points, plus any
  // games already persisted) might now decide the whole match. When they do, a
  // retry shouldn't re-POST each game's scratch save — it should post the
  // canonical result in one shot (the same write the entry screen's "Post
  // result" button fires). Build the merged set the same way the entry screen
  // builds `hypotheticalGames`. Include the active game's failed scratch here:
  // the deciding game stays on its own entry screen (we don't advance once the
  // match is over), so its scratch is what finishes the match. Failed scratch
  // overrides the persisted score for the same game — it's the newer data the
  // cell shows.
  const mergedByNumber = new Map<number, GamePoints>()
  for (const game of data?.games ?? []) {
    if (!game.score || game.game_number === activeGameNumber) continue
    mergedByNumber.set(game.game_number, {
      game_number: game.game_number,
      side_1_points: game.score.side_1_points,
      side_2_points: game.score.side_2_points,
    })
  }
  for (const entry of allFailed) {
    mergedByNumber.set(entry.gameNumber, {
      game_number: entry.gameNumber,
      side_1_points: entry.variables.side_1_points,
      side_2_points: entry.variables.side_2_points,
    })
  }
  const mergedGames = [...mergedByNumber.values()].sort(
    (a, b) => a.game_number - b.game_number,
  )
  const wouldFinalize =
    data != null && decidedSide(mergedGames, data.best_of) !== null

  // Normally the active game is omitted — its pre-filled inputs are the retry
  // surface, so the banner needn't also shout about it. The exception is when
  // the active game's score finishes the match: we stay on it instead of
  // advancing, so it must appear here (informational; see `decidedHere`).
  const failed = wouldFinalize ? allFailed : otherFailed
  const signature = failed.map((entry) => entry.gameNumber).join(',')

  if (failed.length === 0 || signature === dismissedSignature) return null

  // When the active game's own failed scratch is the SOLE failure and it
  // finishes the match, we stayed on its entry screen — so the live inputs above
  // are the authoritative score and the main "Post result" button owns
  // finalizing (it posts those inputs; this banner would post the older cached
  // scratch and silently clobber an edit made after the failed save, #542). Here
  // the banner is informational only. If *other* games also failed, the main
  // button's payload (persisted + live inputs) wouldn't include their unsaved
  // scratch scores, so the banner keeps its own post/retry button — its merged
  // payload does cover them.
  const decidedHere =
    wouldFinalize &&
    otherFailed.length === 0 &&
    allFailed.some((entry) => entry.gameNumber === activeGameNumber)
  // The finalize POST is in flight — lock the button and swap its label.
  const posting = wouldFinalize && finalizeMutation.isPending
  // A finalize that reached the server and failed (409 a result was already
  // posted, 422 validation drift, 500). `useFinalizeMatch`'s contract says its
  // errors matter — unlike the swallowed per-game saves — so the banner
  // surfaces it (the entry screen does the same). Offline we never call
  // finalize (see `retry`), so an error here is always a real server response.
  const finalizeError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null
  const finalizeFailed = finalizeMutation.isError

  const single = failed.length === 1
  const title = wouldFinalize
    ? 'These scores finish the match.'
    : single
      ? `Game ${failed[0].gameNumber} didn't save.`
      : `${failed.length} games didn't save.`
  const description = decidedHere
    ? data?.affects_rating
      ? 'Post the result below to finish the match.'
      : 'Finalize the result below to finish the match.'
    : finalizeFailed
      ? (finalizeError?.detail ??
        finalizeError?.message ??
        "Couldn't post the result — try again.")
      : wouldFinalize
        ? data?.affects_rating
          ? "Post the result now — they didn't save individually, but the match is decided."
          : "Finalize the result now — they didn't save individually, but the match is decided."
        : single
          ? 'Retry now, or tap it in the scoreline to fix the score.'
          : 'Retry all now, or tap a game in the scoreline to fix it.'
  const retryLabel = wouldFinalize
    ? data?.affects_rating
      ? 'Post result'
      : 'Finalize result'
    : single
      ? 'Retry'
      : 'Retry all'

  function retry() {
    // Enough recorded scores to decide the match → post the canonical result
    // (it obliterates + replaces the scratch saves server-side) instead of
    // re-firing each failed per-game save. Offline we can't post /results, so
    // we fall through to re-firing the scratch saves (they stay in the strip as
    // failed cells) — mirroring the entry screen's `onSubmit` online guard
    // rather than firing a finalize that can only fail unseen.
    if (wouldFinalize && onlineManager.isOnline()) {
      finalizeMutation.mutate(
        { games: mergedGames },
        { onSuccess: () => navigate(matchDetailRoute(matchId)) },
      )
      return
    }
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
      <AlertDescription
        className={cn(
          finalizeFailed ? 'text-[color:var(--loss)]' : 'text-[color:var(--fg-3)]',
        )}
      >
        {description}
      </AlertDescription>
      <AlertAction className="top-1/2 flex -translate-y-1/2 items-center gap-1">
        {!decidedHere && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
            onClick={retry}
            disabled={posting}
          >
            <RotateCw aria-hidden />
            {posting ? 'Posting…' : retryLabel}
          </Button>
        )}
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
