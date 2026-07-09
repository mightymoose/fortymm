import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { RotateCw, TriangleAlert, X as XIcon } from 'lucide-react'
import { ApiError } from '@/api/client'
import {
  fireScoreSave,
  matchDetailRoute,
  scoringEditRoute,
  useProposeResult,
  useMatch,
} from '@/api/matches'
import { compactGames, isDecidedMatch } from '@/lib/scoring'
import { cn } from '@/lib/utils'
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { reconstructBoard, scoredGamePoints } from './reconstruct-board'
import { useFailedGameSaves } from './score-saves'

export interface SaveBannerProps {
  matchId: string
  /** The game whose entry screen is mounted. Its own failure is normally
   * omitted — the pre-filled inputs are the retry surface there, so the banner
   * needn't also shout about it. The exception is when that game's score
   * finishes the match: we stay on it, the banner surfaces (informational
   * only), and the main "Post result" button owns finalizing. */
  activeGameNumber: number
  /** The entry screen's own propose mutation, shared so a "Post result" fired
   * from this banner and one fired from the main button are the *same* request.
   * That way a board-level conflict (issue D1) surfaces once — on the entry
   * screen's blocking interstitial — instead of only inside this banner, and
   * the banner is hidden while that interstitial owns the reconcile. */
  proposeMutation: ReturnType<typeof useProposeResult>
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
export function SaveBanner(props: SaveBannerProps) {
  // Two distinct banners stacked: concurrency conflicts (which must NOT be
  // blindly retried — that's the data-loss path) get their own review-against-
  // committed surface; ordinary save failures keep the retry/finalize banner.
  return (
    <>
      <ConflictReviewBanner {...props} />
      <FailedSaveBanner {...props} />
    </>
  )
}

function FailedSaveBanner({
  matchId,
  activeGameNumber,
  proposeMutation: finalizeMutation,
}: SaveBannerProps) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const { data } = useMatch(matchId)
  // Conflicts are handled by ConflictReviewBanner — exclude them here so the
  // retry/finalize path never re-fires a stale write over the committed score.
  const allFailed = useFailedGameSaves(matchId).filter((entry) => !entry.conflict)
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
  // builds `hypotheticalGames`. Include the active game too — its own persisted
  // score is part of the real board, so a cleanly-persisted active game must
  // not be dropped or the match reads as not-decided and the finalize CTA hides
  // behind an unrelated failed game (#755). The active game's failed scratch,
  // when it has one, still wins below: the failed-saves loop overrides the same
  // game number, and that scratch — not the persisted score — is what the cell
  // shows and what finishes the match (we don't advance once it's over).
  // The shared board reconstruction (ADR 0004): persisted ⊕ failed scratch.
  // The banner reads no live input — it may be on another game's screen — so it
  // passes no `activeInput`, deferring the active game's live value to
  // `score-entry`'s button via `decidedHere` below. `allFailed` already excludes
  // conflicts (see above), as the helper requires.
  // Compact so a gappy offline clinch posts a contiguous board (see
  // `compactGames`). `compactGames` sorts internally, so no pre-sort here.
  const mergedGames = compactGames(
    reconstructBoard({
      persisted: scoredGamePoints(data?.games ?? []),
      failedSaves: allFailed,
    }),
  )
  const wouldFinalize =
    data != null && isDecidedMatch(mergedGames, data.best_of)

  // Normally the active game is omitted — its pre-filled inputs are the retry
  // surface, so the banner needn't also shout about it. The exception is when
  // the active game's score finishes the match: we stay on it instead of
  // advancing, so it must appear here (informational; see `decidedHere`).
  const failed = wouldFinalize ? allFailed : otherFailed
  // Key the dismiss by each failure's identity, not just its game number: a
  // single game that fails, is dismissed, then fails again on retry keeps the
  // same failed set ({N}) but a fresh `submittedAt`, so folding the timestamp
  // in re-surfaces the banner for the new failure instead of staying hidden
  // (#528).
  const signature = failed
    .map((entry) => `${entry.gameNumber}:${entry.submittedAt}`)
    .join(',')

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
  // posted, 422 validation drift, 500). `useProposeResult`'s contract says its
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
        {
          // App-initiated hop inside score-entry's blocker scope: the result has
          // already posted server-side, so prompting "Leave without saving?"
          // would be wrong. Bypass the dirty-form guard on this one navigation
          // (ADR 0014, #818) — the banner lives inside ScoreEntryInner, so its
          // navigations are caught by that component's still-armed blocker.
          onSuccess: () =>
            navigate({ ...matchDetailRoute(matchId), ignoreBlocker: true }),
        },
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

/**
 * Conflict surface for games saved out from under the user — a concurrent
 * participant committed a different score, so the conditional write 409'd.
 * Unlike a plain failed save, this offers NO retry: re-firing would push the
 * stale entry over the committed score (the exact last-write-wins data loss the
 * version guard prevents). It routes the user to the game's edit screen, where
 * the conflict notice shows committed-vs-theirs and makes them re-decide.
 *
 * The active game is omitted — its own edit screen already renders the in-page
 * conflict notice (mirrors how FailedSaveBanner omits the active game).
 */
function ConflictReviewBanner({ matchId, activeGameNumber }: SaveBannerProps) {
  const navigate = useNavigate()
  const conflicts = useFailedGameSaves(matchId).filter(
    (entry) => entry.conflict && entry.gameNumber !== activeGameNumber,
  )
  const [dismissedSignature, setDismissedSignature] = useState<string | null>(
    null,
  )

  if (conflicts.length === 0) return null
  const signature = conflicts
    .map((entry) => `${entry.gameNumber}:${entry.submittedAt}`)
    .join(',')
  if (signature === dismissedSignature) return null

  const single = conflicts.length === 1
  const title = single
    ? `Game ${conflicts[0].gameNumber} was saved by someone else.`
    : `${conflicts.length} games were saved by someone else.`

  return (
    <Alert
      variant="destructive"
      className="save-banner mb-4 border-[color:var(--loss)]/45 bg-[color:var(--loss)]/10 has-data-[slot=alert-action]:pr-12"
    >
      <TriangleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="text-[color:var(--fg-3)]">
        <span>
          Review {single ? 'it' : 'them'} against the saved score before saving
          again — your entry wasn't applied.
        </span>
        <span className="mt-3 flex flex-wrap gap-2">
          {conflicts.map((entry) => (
            <Button
              key={entry.gameNumber}
              type="button"
              variant="outline"
              size="sm"
              className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
              onClick={() =>
                // User-initiated hop, NOT the app's — the same gesture as the
                // scoreline <Link>, so it deliberately does NOT bypass the
                // dirty-form guard (ADR 0014, #818). The user chose to jump to
                // another game; if they typed into the active one, warn them.
                navigate(scoringEditRoute(matchId, entry.gameNumber))
              }
            >
              Review game {entry.gameNumber}
            </Button>
          ))}
        </span>
      </AlertDescription>
      <AlertAction className="top-3 -translate-y-0">
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
