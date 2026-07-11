import { useEffect, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, TriangleAlert, X as XIcon } from 'lucide-react'
import { ApiError } from '@/api/client'
import {
  forgetScoreSaves,
  matchDetailRoute,
  recordedGameNumbers,
  scoringEditRoute,
  scoringNewRoute,
  useDeleteScore,
  useDeleteScoreForMatch,
  useProposeResult,
  useMatch,
  useSaveGameScore,
  type MatchDetails,
  type MatchGameScoreWrite,
  type MatchResultsGameWrite,
} from '@/api/matches'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { cn, initialsOf } from '@/lib/utils'
import {
  compactGames,
  deciderGameNumber,
  isDecidedMatch,
  overrunDecider,
} from '@/lib/scoring'
import { reconstructBoard, scoredGamePoints } from './reconstruct-board'
import {
  isScoreConflict,
  useFailedGameSaves,
  useGameSaveState,
} from './score-saves'
import { SaveBanner } from './save-banner'
import { ScorePad } from './score-pad'
import {
  isAcceptableScoreInput,
  validateGameScore,
} from './score-pad/validate-game-score'

/** The non-null persisted score on a game. */
type PersistedScore = NonNullable<MatchDetails['games'][number]['score']>

// Placeholder for the opponent label on solo matches — mirrors the match
// details hero. Distinct from `initialsOf('Opponent')` so users can tell
// "no opponent" apart from a real two-letter monogram.
const NO_OPPONENT_LABEL = 'No opponent'

export type ScoreEntryMode = { kind: 'create' } | { kind: 'edit' }

export function ScoreEntry({
  matchId,
  gameNumber,
  mode,
}: {
  matchId: string
  gameNumber: number
  mode: ScoreEntryMode
}) {
  // Remount whenever the URL targets a different game (or flips create/edit)
  // so the typed-input state and finalize-error state don't leak across games.
  return (
    <ScoreEntryInner
      key={`${gameNumber}:${mode.kind}`}
      matchId={matchId}
      gameNumber={gameNumber}
      mode={mode}
    />
  )
}

function ScoreEntryInner({
  matchId,
  gameNumber,
  mode,
}: {
  matchId: string
  gameNumber: number
  mode: ScoreEntryMode
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data, isLoading } = useMatch(matchId)
  const saveMutation = useSaveGameScore(matchId, gameNumber)
  const deleteMutation = useDeleteScore(matchId, gameNumber)
  const cellDeleteMutation = useDeleteScoreForMatch(matchId)
  const finalizeMutation = useProposeResult(matchId)
  // This game's own latest save state, read from the shared mutation cache —
  // used only to pre-fill the inputs after a failed save (the scoreline cells
  // and banner each read their own state).
  const ownSave = useGameSaveState(matchId, gameNumber)
  // Every match game whose latest scratch save failed — needed so the finalize
  // board folds in a game that failed on a *different* screen (issue #747-F2;
  // ADR 0004). Conflicts are excluded below before the fold: their committed
  // value is already persisted, and re-adding the rejected scratch would
  // silently overwrite it.
  const failedSaves = useFailedGameSaves(matchId)

  // `null` means "user hasn't typed anything yet" — we fall through to the
  // persisted score in edit mode. Avoids a state-syncing effect when `data`
  // arrives after first render.
  const [meTyped, setMeTyped] = useState<string | null>(null)
  const [oppTyped, setOppTyped] = useState<string | null>(null)
  const meRef = useRef<HTMLInputElement>(null)
  const oppRef = useRef<HTMLInputElement>(null)
  // Set when a per-cell clear is confirmed: the dialog otherwise restores focus
  // to its trigger (the now-removed ✕), so we re-grab focus for the first empty
  // input in the dialog's close-focus hook instead.
  const refocusAfterCloseRef = useRef(false)
  // The game whose saved score is pending a clear-confirmation, or `'active'`
  // for the in-page Clear button (which clears the game being edited above).
  // `null` means no confirmation is open. Clearing discards a recorded game, so
  // it asks first rather than firing instantly (#387).
  const [pendingClear, setPendingClear] = useState<number | 'active' | null>(
    null,
  )

  // Guard against losing un-submitted typing on refresh/close or an in-app
  // navigation (#441). `isDirty` is driven by the score change handlers as the
  // user types (set below, once `data`-derived baselines are in scope) — the
  // blocker only reads it. The app's own navigations (Save's next-game hop,
  // finalize's success hop, the clear-then-recreate hop) bypass the guard by
  // passing `ignoreBlocker: true` on the navigation itself — a per-hop argument
  // rather than a stored latch (ADR 0014, #818).
  //
  // `isDirty` stays stored state (not derived per-render from `computeDirty`)
  // on purpose (ADR 0014). The dirty baseline folds in a failed save
  // (`baselineMe = failedMe != null ? String(failedMe) : persistedMe…`), so a
  // derived `isDirty` would compute `false` the instant an offline deciding-game
  // save fails; `enableBeforeUnload` would then return `false` and closing the
  // tab would silently discard that deciding score — it was never on the server,
  // and the mutation cache holding it is in-memory only (no `persistQueryClient`).
  // Deriving `isDirty` trades a stale boolean for silent data loss; leave it
  // stored.
  const [isDirty, setIsDirty] = useState(false)
  // Synchronous finalize-in-flight guard. `finalizeMutation.isPending` is a
  // render snapshot that only flips on the next commit, so a fast double-click
  // on "Finalize result" lands a second tap before React re-renders — firing
  // two concurrent POST /results that pile up and wedge the backend (#641).
  // This ref flips inside the click gesture, so the second tap is rejected
  // regardless of render timing. Cleared on *error* only: a successful finalize
  // navigates away from this screen, so the guard never needs to reopen on
  // success — clearing on settle would reopen it a beat before the navigation
  // lands, leaving a window for a duplicate. Error clears it so a retry works.
  const finalizingRef = useRef(false)
  // Synchronous clear-in-flight guard (#869). The confirm dialog's `open` is
  // driven by `pendingClear !== null` — a render snapshot — so the confirm
  // button stays mounted and clickable until React re-renders. Two clicks
  // delivered synchronously in one frame both close over the same captured
  // `target`, both clear `pendingClear`, and both reach `.mutate` before the
  // re-render — firing two DELETE .../scores requests. Like `finalizingRef`,
  // this ref flips inside the click gesture, so the second tap is rejected
  // regardless of render timing. Reset in each mutation's `onSettled` so a
  // later clear of a *different* game works normally.
  const clearingRef = useRef(false)
  const { status, proceed, reset } = useBlocker({
    // Blocks browser refresh/close (beforeunload) only while genuinely dirty.
    enableBeforeUnload: () => isDirty,
    // Blocks in-app route changes the same way. The app's own hops opt out per
    // navigation via `ignoreBlocker: true`, so there's nothing to check here but
    // the dirty flag (ADR 0014, #818).
    shouldBlockFn: () => isDirty,
    withResolver: true,
  })

  if (isLoading || !data) {
    return (
      <>
        <div aria-busy="true" data-testid="score-entry-loading" />
      </>
    )
  }

  // The five `<Navigate>` guard redirects below are all app-initiated: each is
  // computed purely from server data with no user gesture, so each bypasses the
  // unsaved-input blocker via `ignoreBlocker`. Foot-gun: omitting it doesn't
  // merely prompt — a blocked `<Navigate>` re-fires and wedges the screen. See
  // ADR 0014 (#818) for the spin mechanism.

  // The scoring screen is participant-only; spectators bounce back to the
  // read-only details page. The opponent side is always present — a real
  // player, or the player-less placeholder for solo matches.
  const mySide = data.sides.find((s) => s.is_current_user_side) ?? null
  const oppSide = data.sides.find((s) => !s.is_current_user_side) ?? null
  if (!mySide || !oppSide) {
    return <Navigate {...matchDetailRoute(matchId)} ignoreBlocker />
  }

  // Once a match is finalized every write path 409s — there's nothing to do
  // here. Same goes once a result is posted — scores are frozen the instant the
  // first proposal lands; accepting it lives on the match-details page.
  if (
    data.status === 'completed' ||
    data.negotiation.standing_result !== null
  ) {
    return <Navigate {...matchDetailRoute(matchId)} ignoreBlocker />
  }
  // The game number past which no more games can be played: once a side has
  // clinched (gap-tolerant), the trailing games are unplayable. Drives the nav
  // bounce below and (passed down) the scoreline cell gating, mirroring the
  // server's "no games past the decider" guard on the score-write endpoints.
  const scoredGames = scoredGamePoints(data.games)
  const decider = deciderGameNumber(scoredGames, data.best_of)
  const isScored = (n: number) =>
    data.games.some((g) => g.game_number === n && g.score)

  // Bounce out-of-range games, and any *unscored* game past the decider — those
  // can never be played. An already-scored game at/under the decider stays
  // editable (you can still fix the deciding game itself).
  if (
    !Number.isInteger(gameNumber) ||
    gameNumber < 1 ||
    gameNumber > data.best_of ||
    (decider !== null && gameNumber > decider && !isScored(gameNumber))
  ) {
    return <Navigate {...matchDetailRoute(matchId)} ignoreBlocker />
  }

  const game = data.games.find((g) => g.game_number === gameNumber) ?? null
  const persistedScore = game?.score ?? null

  // Mode/URL/state alignment: in create mode but a score exists → swap to
  // the edit URL so Save doesn't try to POST .../scores/new and 409. The
  // inverse — edit mode but no saved score — swaps to the create URL.
  // Skipped while this page's own save is settling: the success cache
  // write makes the score "exist" a beat before onSettled navigates to the
  // next game, and this redirect must not outrun that navigation.
  if (mode.kind === 'create' && persistedScore && !saveMutation.isSuccess) {
    return (
      <Navigate {...scoringEditRoute(matchId, gameNumber)} replace ignoreBlocker />
    )
  }
  if (mode.kind === 'edit' && !persistedScore) {
    return (
      <Navigate {...scoringNewRoute(matchId, gameNumber)} replace ignoreBlocker />
    )
  }

  const mySideNumber: 1 | 2 = mySide.side_number === 2 ? 2 : 1
  const oppUsername = oppSide.players[0]?.username ?? null
  const oppName = oppUsername ?? NO_OPPONENT_LABEL
  const meName = mySide.players[0]?.username ?? 'You'
  const meInitials = initialsOf(meName)
  const oppHasPlayer = oppUsername !== null

  const bestOf = data.best_of
  const meWins = mySide.games_won
  const oppWins = oppSide.games_won

  const persistedMe =
    persistedScore &&
    (mySideNumber === 1
      ? persistedScore.side_1_points
      : persistedScore.side_2_points)
  const persistedOpp =
    persistedScore &&
    (mySideNumber === 1
      ? persistedScore.side_2_points
      : persistedScore.side_1_points)
  // A failed save's points pre-fill ahead of the persisted score — they're
  // the newer scratch data, and pre-filling is what makes opening a failed
  // game from the scoreline a real retry rather than a blank do-over. They
  // live on this game's failed mutation in the shared cache.
  const failedEntry = ownSave?.status === 'error' ? ownSave.variables : null
  const failedMe =
    failedEntry &&
    (mySideNumber === 1 ? failedEntry.side_1_points : failedEntry.side_2_points)
  const failedOpp =
    failedEntry &&
    (mySideNumber === 1 ? failedEntry.side_2_points : failedEntry.side_1_points)
  // This game's last save was rejected because a concurrent participant had
  // already saved it (a 409 from the conditional write). That's the data-loss
  // case the version guard exists for: rather than silently overwrite their
  // result, we show both scores and make the user re-decide against the
  // committed value (`persistedScore` is the refetched server truth — the
  // `onError` re-sync primed it). Distinct from a plain failed save, which the
  // scoreline/banner just offer to retry.
  const conflict = ownSave?.status === 'error' && isScoreConflict(ownSave.error)
  const me =
    meTyped ??
    (failedMe != null
      ? String(failedMe)
      : persistedMe != null
        ? String(persistedMe)
        : '')
  const opp =
    oppTyped ??
    (failedOpp != null
      ? String(failedOpp)
      : persistedOpp != null
        ? String(persistedOpp)
        : '')

  // The baseline is what the inputs read with no local typing — the failed
  // scratch save, else the persisted score, else empty. Input is "dirty"
  // (worth guarding on exit) only when the user has actually typed something
  // that diverges from that baseline: a clean page, or input that merely
  // matches what's already saved, must not nag. Updating the ref here (rather
  // than in an effect) keeps the blocker reading the current-render truth.
  const baselineMe =
    failedMe != null ? String(failedMe) : persistedMe != null ? String(persistedMe) : ''
  const baselineOpp =
    failedOpp != null
      ? String(failedOpp)
      : persistedOpp != null
        ? String(persistedOpp)
        : ''
  // Whether the live inputs (me/opp) diverge from the baseline — i.e. there's
  // genuinely-unsaved typing worth guarding on exit. Recomputed by the change
  // handlers below as the user types (a clean page, or input matching the
  // saved score, isn't dirty). Compared on digits only: the field now keeps
  // malformed text verbatim (#624), and a stray "." in "11." over a saved "11"
  // must not read as a change and spuriously trip the unsaved-changes blocker
  // (#441) — the baseline is always a clean digit-string, so this matches it.
  const digitsOnly = (value: string) => value.replace(/[^0-9]/g, '')
  const computeDirty = (nextMe: string, nextOpp: string) =>
    digitsOnly(nextMe) !== baselineMe || digitsOnly(nextOpp) !== baselineOpp

  // Take the typed value verbatim — no stripping, no truncating (#624); the
  // shared `isAcceptableScoreInput` only blocks characters that can't begin a
  // score (letters, sign). Keeping the raw text lets a malformed entry stay
  // visible and get flagged inline instead of masquerading as a real score.
  const onMeChange = (value: string) => {
    if (!isAcceptableScoreInput(value)) return
    setMeTyped(value)
    setIsDirty(computeDirty(value, opp))
    if (finalizeMutation.error) finalizeMutation.reset()
  }
  const onOppChange = (value: string) => {
    if (!isAcceptableScoreInput(value)) return
    setOppTyped(value)
    setIsDirty(computeDirty(me, value))
    if (finalizeMutation.error) finalizeMutation.reset()
  }

  // The shared single-game verdict: 1–3-digit well-formedness, the "exactly one
  // side filled" hint (#387), and the `illegalScoreReason` table-tennis rule.
  // Now shared with the propose-a-result correction surface via `score-pad`.
  const validation = validateGameScore(me, opp)
  const oneSideFilled = validation.oneSideFilled
  const meMalformed = validation.meMalformed
  const oppMalformed = validation.oppMalformed
  const formatError = meMalformed || oppMalformed ? validation.error : null
  const localScoreError = validation.error
  const inputsValid = validation.valid
  const finalizeApiError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null
  // A finalize error that ISN'T an `ApiError` is a transport-level drop:
  // `useProposeResult` runs `networkMode: 'always'`, so a finalize whose
  // connection dies mid-flight still fires the POST and `fetch` rejects with a
  // plain `TypeError` — never an `ApiError` (#868). The at-submit offline guard
  // below (`wouldFinalize && onlineManager.isOnline()`) diverts a *known*-offline
  // deciding game to the scratchpad, but it can't catch a connection that dies
  // AFTER it passes — that rejection lands here. Mutually exclusive with
  // `finalizeApiError` by construction (the error is one or the other, never
  // both). Mirrors correction-entry's `networkError` (#839): error-driven, not a
  // `navigator.onLine` pre-check, on purpose — the pre-check races the actual
  // request, so we branch on the rejection that really happened.
  const finalizeNetworkError =
    finalizeMutation.error !== null && finalizeApiError === null

  // Build the hypothetical full-match games list including the current input,
  // so we can ask the scoring lib whether saving this entry would make the
  // match finalize-able. If so, the single submit button swaps to "Finalize
  // match" and posts /results instead of /scores/new.
  //
  // Reconstructed from all three sources (ADR 0004) via the shared helper the
  // banner also uses: persisted ⊕ failed scratch ⊕ this game's live input. The
  // failed-scratch fold is the #747-F2 fix — without it a game that failed to
  // save on a different screen compacts out and a 2–1 board posts as 2–0.
  // Conflicts are excluded (their committed value is already in `scoredGames`);
  // the live input is layered last, so it wins for the active game even over its
  // own failed scratch.
  const hypotheticalGames: MatchResultsGameWrite[] = inputsValid
    ? reconstructBoard({
        persisted: scoredGames,
        failedSaves: failedSaves.filter((entry) => !entry.conflict),
        activeInput: { game_number: gameNumber, ...toBody() },
      })
    : []
  // The canonical board this entry would post — an out-of-order clinch's gap
  // closed (see `compactGames`), so the predicate and the posted payload below
  // are always the same board and can't diverge.
  const compactedGames = compactGames(hypotheticalGames)
  // Compact before asking "is this a decided board?" so an out-of-order clinch
  // takes the finalize branch instead of funnelling into the empty gap game (the
  // #742 dead-end). A real overrun compacts to itself and stays non-final.
  const wouldFinalize = inputsValid && isDecidedMatch(compactedGames, bestOf)

  // Mirror the server's "no games past the decider" guard inline. The scoreline
  // already mutes/bounces the games numbered after a known decider, but one path
  // slips through: scoring a later game *clinches* the match while an earlier
  // game is still blank, then the user goes back to fill that gap — which would
  // leave the match decided before its last scored game (impossible). Catch it
  // here so the user sees an actionable message and stays on the screen, instead
  // of firing a write the server 422s and getting navigated away with no reason.
  const overrunAt = inputsValid ? overrunDecider(hypotheticalGames, bestOf) : null

  // Per the fire-and-forget posture: only finalize errors are surfaced. The
  // per-game mutations (save / delete) self-heal at finalize, so their errors
  // are intentionally hidden here (surfaced in the scoreline instead). All
  // finalize errors surface, not just 422 validation drift — for a deciding
  // game this button is the sole finalize path (the banner is informational),
  // so a 409 "already posted" / 500 must be visible here rather than swallowed.
  // The score *inputs* are only invalid for genuine validation problems (local
  // illegal score, or a 422 drift the server rejected) — a 409/500 means the
  // entered score is fine, so don't paint the fields red for those. A
  // transport-level drop (`finalizeNetworkError`) is the same story: the entered
  // score is perfectly valid, the POST just never reached the server, so the
  // fields stay clean and only the message line explains the failure (#868).
  const inputsInvalid =
    localScoreError !== null || finalizeApiError?.status === 422
  // The message line, though, surfaces every finalize error (409/500 included),
  // a transport-level drop, and the cross-game overrun block (a legal score that
  // the board can't take).
  const overrunError =
    overrunAt !== null
      ? `The match is already decided at game ${overrunAt} — clear the games after it before saving this score.`
      : null
  const showScoreError =
    inputsInvalid ||
    overrunError !== null ||
    finalizeApiError !== null ||
    finalizeNetworkError
  // The "both scores required" hint is its own, lower-severity line — shown only
  // when exactly one field is filled and there's no harder error to surface.
  const showBothRequired = oneSideFilled && !showScoreError
  // Per-side red flags: a format error paints only the malformed side; a
  // genuine scoring error (illegal score / 422 drift) paints both inputs; the
  // both-required hint only flags the empty one.
  const meInvalid =
    meMalformed ||
    (formatError === null && inputsInvalid) ||
    (showBothRequired && me === '')
  const oppInvalid =
    oppMalformed ||
    (formatError === null && inputsInvalid) ||
    (showBothRequired && opp === '')

  function predictNextScoringRoute() {
    if (!data) return matchDetailRoute(matchId)
    // Persisted scores live in `data.games`; offline-entered ones never land
    // there (the saves fail), so also count games sitting in the mutation cache
    // as failed/in-flight scratch saves — otherwise after the second offline
    // game this loop bounces back to game 1 instead of advancing. Read the
    // cache live here (right before firing this game's save) so a prior game
    // that just settled is already counted.
    const nowScored = new Set<number>([
      ...data.games.filter((g) => g.score).map((g) => g.game_number),
      ...recordedGameNumbers(queryClient, matchId),
      gameNumber,
    ])
    for (let n = 1; n <= data.best_of; n += 1) {
      if (!nowScored.has(n)) return scoringNewRoute(matchId, n)
    }
    return matchDetailRoute(matchId)
  }

  function toBody(): MatchGameScoreWrite {
    return mySideNumber === 1
      ? { side_1_points: Number(me), side_2_points: Number(opp) }
      : { side_1_points: Number(opp), side_2_points: Number(me) }
  }

  function onSubmit() {
    if (!inputsValid) return
    // The score is legal on its own but the board can't take it (it would leave
    // the match decided before its last game). Block the write — the inline
    // `overrunError` tells the user to clear the trailing games first.
    if (overrunAt !== null) return
    // Ignore a second Save while the per-game save is still in flight (#538):
    // a double-tap would otherwise fire a duplicate create that 409s. This
    // synchronous guard is the only protection now — the mutationFn no longer
    // swallows that 409 (it would surface as a conflict to review), so don't
    // let a double-tap reach it.
    if (saveMutation.isPending) return
    // Same for a second submit while the finalize POST is in flight (#550,
    // #641). `finalizeMutation.isPending` is a render snapshot and the submit
    // button's `disabled` only takes effect on the next commit, so a fast
    // double-click lands a second tap before React re-renders. The
    // `finalizingRef` flips synchronously inside this gesture, so it catches
    // the second tap even within the same frame — fire one POST /results, not
    // two concurrent ones that wedge the backend.
    if (finalizeMutation.isPending || finalizingRef.current) return
    // This is the sanctioned write path: any navigation it triggers (the
    // synchronous next-game hop, or finalize's onSuccess to the match page) is
    // intentional, so each `navigate()` below passes `ignoreBlocker: true` to
    // wave the unsaved-input blocker through that one hop (ADR 0014, #818).
    // Finalizing posts the canonical result — but that's the one write that
    // can't be faked offline. When offline we instead fall through to the
    // scratchpad save below, which stores the deciding game's score in the
    // mutation cache (visible as a failed cell) so it survives until the user
    // can post the result back online. Online, finalize as usual.
    if (wouldFinalize && onlineManager.isOnline()) {
      finalizingRef.current = true
      finalizeMutation.mutate(
        { games: compactedGames },
        {
          onSuccess: () =>
            navigate({ ...matchDetailRoute(matchId), ignoreBlocker: true }),
          onError: () => {
            finalizingRef.current = false
          },
        },
      )
      return
    }
    const args = toBody()
    // Offline deciding game: store the score as a scratch save but DON'T advance
    // — the match is over, there's no next game to play. Staying here, the save's
    // failure makes the SaveBanner surface on this same screen ("These scores
    // finish the match." / "Post result"), which posts the canonical result once
    // back online.
    if (wouldFinalize) {
      // We're abandoning the finalize attempt in favour of a scratch save, so any
      // finalize error still on screen (e.g. a prior mid-flight transport drop's
      // connection copy, #868) is stale by definition — nothing in this branch
      // re-runs the finalize mutation to clear it, so reset it here before the
      // scratch save's SaveBanner takes over.
      finalizeMutation.reset()
      saveMutation.mutate(args)
      return
    }
    const next = predictNextScoringRoute()
    // Fire-and-forget — navigate to the next game *synchronously*, in the same
    // user gesture, without waiting for the request to settle. The save lands
    // in the shared mutation cache under this game's key (pending immediately),
    // so the next screen's scoreline cell reads "saving" and the route
    // prediction already counts it; on success the cell flips to "saved", on
    // failure to the failed-save state (#369) with the entered points retained.
    // Navigating inside the gesture — rather than from a later onSettled, after
    // the network round-trip — is what keeps the mobile soft keyboard open: a
    // browser only honours the next input's autofocus while still inside the
    // tap that triggered it, so deferring to onSettled dropped focus and closed
    // the keyboard between games (#567).
    saveMutation.mutate(args)
    navigate({ ...next, ignoreBlocker: true })
  }

  // After any clear, drop focus into the first input that's still empty so
  // the user can keep typing without grabbing the mouse. Reads the controlled
  // state, not the DOM — those are equal but the state is canonical and
  // doesn't drift if React batches a render between mutate() and this call.
  function focusFirstEmpty() {
    if (me === '') {
      meRef.current?.focus()
    } else if (opp === '') {
      oppRef.current?.focus()
    }
  }

  // Clearing discards a recorded game's score — an irreversible write. Both
  // clear affordances (the in-page Clear button and the per-cell ✕) route
  // through a confirmation dialog (#387); only on confirm do we actually fire
  // the delete. `pendingClear` carries which game is being discarded.
  function performClear() {
    const target = pendingClear
    setPendingClear(null)
    if (target === null) return
    // Reject a second synchronous confirm click while a clear is already in
    // flight (#869) — the ref is set right before each `.mutate` below and
    // cleared in that mutation's `onSettled`, so a legitimate later clear of a
    // different game still fires normally.
    if (clearingRef.current) return
    if (target === 'active') {
      if (mode.kind !== 'edit') return
      // Clearing is an explicit discard — drop any failed-save leftovers too,
      // so a stale failure doesn't outlive the score it referred to. The
      // edit→new hop it triggers is intentional, so its `navigate()` passes
      // `ignoreBlocker: true` to keep the unsaved-input blocker out of it
      // (ADR 0014, #818).
      forgetScoreSaves(queryClient, matchId, gameNumber)
      clearingRef.current = true
      deleteMutation.mutate(undefined, {
        // After clearing, land back on this game's create route so the user
        // can re-enter — same page, just with empty inputs and create-mode
        // semantics. The remount's autoFocus puts focus on the me-input,
        // which is the first empty input.
        onSettled: () => {
          clearingRef.current = false
          navigate({ ...scoringNewRoute(matchId, gameNumber), ignoreBlocker: true })
        },
      })
      return
    }
    // Per-cell ✕ — clears the score for any logged game from the scoreline
    // strip. We refocus the first empty input on the current page so the user
    // can keep typing (deferred to the dialog's close-focus hook).
    forgetScoreSaves(queryClient, matchId, target)
    clearingRef.current = true
    cellDeleteMutation.mutate(target, {
      onSettled: () => {
        clearingRef.current = false
      },
    })
    refocusAfterCloseRef.current = true
  }

  function onClear() {
    if (mode.kind !== 'edit') return
    setPendingClear('active')
  }

  function onClearCell(n: number) {
    setPendingClear(n)
  }

  // Conflict resolution. The user has seen both their rejected entry and the
  // committed score; now they pick one — the explicit re-decision the version
  // guard forces before any further write to this game.
  function keepCommittedScore() {
    // Drop our rejected scratch save; the inputs fall back to the committed
    // score and the conflict notice clears.
    forgetScoreSaves(queryClient, matchId, gameNumber)
    setMeTyped(null)
    setOppTyped(null)
    setIsDirty(false)
  }

  function overwriteWithMyScore() {
    if (!failedEntry) return
    // Re-fire the save. The cache now holds the committed score (and its newer
    // version), so the mutation PUTs with that fresh version and overwrites
    // deliberately — no longer a blind last-write-wins, but a choice made
    // against the value we just showed them. This path never navigates, so
    // there is nothing for the unsaved-input blocker to bypass here (ADR 0014,
    // #818): a later user-initiated navigation while still dirty must stay
    // blocked, which the old always-armed latch wrongly waved through.
    saveMutation.mutate(failedEntry)
  }

  function handleKey(
    e: React.KeyboardEvent<HTMLInputElement>,
    side: 'me' | 'opp',
  ) {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (side === 'me' && me !== '') {
        oppRef.current?.focus()
        oppRef.current?.select()
      } else if (side === 'opp') {
        onSubmit()
      }
    } else if (e.key === 'ArrowRight' && side === 'me') {
      e.preventDefault()
      oppRef.current?.focus()
      oppRef.current?.select()
    } else if (e.key === 'ArrowLeft' && side === 'opp') {
      e.preventDefault()
      meRef.current?.focus()
      meRef.current?.select()
    }
  }

  // Only finalize pending state locks inputs — per-game mutations are
  // fire-and-forget, so we don't want to make the UI feel laggy on those.
  const inputsLocked = finalizeMutation.isPending
  const isEdit = mode.kind === 'edit'

  const heading = isEdit
    ? `Edit game ${gameNumber} score.`
    : `Enter game ${gameNumber} score.`
  const subtitle = wouldFinalize
    ? data.affects_rating
      ? 'This score finishes the match — submitting posts the result for your opponent to accept.'
      : 'This score finishes the match — submitting will finalize the result immediately.'
    : isEdit
      ? 'Save updates the score for this game.'
      : gameNumber < bestOf
        ? `Save this game to continue to game ${gameNumber + 1}.`
        : bestOf === 1
          ? 'Save to post the result.'
          : 'Final game. Save to post the result.'
  const submitLabel = wouldFinalize
    ? finalizeMutation.isPending
      ? data.affects_rating
        ? 'Posting result…'
        : 'Finalizing…'
      : data.affects_rating
        ? 'Post result'
        : 'Finalize result'
    : isEdit
      ? 'Save changes →'
      : gameNumber < bestOf
        ? 'Save game & next →'
        : bestOf === 1
          ? 'Save & post →'
          : 'Save final game →'

  return (
    <>
      <div className="entry-wrap">
        <div className="entry-head">
          <h2>{heading}</h2>
          <div className="hint">
            Type <kbd>0</kbd>–<kbd>9</kbd> &nbsp;·&nbsp; <kbd>Enter</kbd>{' '}
            {bestOf === 1 ? 'to save' : 'for next / save game'}
          </div>
        </div>

        <SaveBanner
          matchId={matchId}
          activeGameNumber={gameNumber}
          proposeMutation={finalizeMutation}
        />

        {conflict && (
          <ScoreConflictNotice
            meName={meName}
            oppName={oppName}
            committedMe={persistedMe ?? null}
            committedOpp={persistedOpp ?? null}
            yourMe={failedMe ?? null}
            yourOpp={failedOpp ?? null}
            onKeepCommitted={keepCommittedScore}
            onUseMine={overwriteWithMyScore}
          />
        )}

        <ScorePad
          me={{
            name: meName,
            initials: meInitials,
            value: me,
            inputRef: meRef,
            autoFocus: true,
            invalid: meInvalid,
            onChange: onMeChange,
            onKeyDown: (e) => handleKey(e, 'me'),
          }}
          opp={{
            name: oppName,
            initials: oppHasPlayer ? initialsOf(oppName) : null,
            value: opp,
            inputRef: oppRef,
            invalid: oppInvalid,
            onChange: onOppChange,
            onKeyDown: (e) => handleKey(e, 'opp'),
          }}
          gamesTally={bestOf > 1 ? `${meWins} – ${oppWins}` : null}
          // The scratchpad surfaces the local validation error, the cross-game
          // overrun block, a finalize API rejection (409/500 too), and — last in
          // precedence — a transport-level drop's connection copy here;
          // `showScoreError` gates when any of them shows, in that order. The
          // connection copy is last because an `ApiError` (a real server verdict)
          // is always the more specific thing to say; a bare transport failure is
          // the fallback when the POST never reached the server at all (#868).
          scoreError={
            showScoreError
              ? (localScoreError ??
                overrunError ??
                finalizeApiError?.detail ??
                finalizeApiError?.message ??
                (finalizeNetworkError
                  ? "Couldn't post the result — check your connection and try again."
                  : null))
              : null
          }
          showBothRequired={showBothRequired}
          inputsLocked={inputsLocked}
          subtitle={subtitle}
          submitLabel={submitLabel}
          canSubmit={inputsValid && overrunAt === null}
          onSubmit={onSubmit}
          onClear={isEdit ? onClear : undefined}
          clearDisabled={deleteMutation.isPending}
        />

        {bestOf > 1 && (
          <Scoreline
            data={data}
            activeGameNumber={gameNumber}
            decider={decider}
            matchId={matchId}
            mySideNumber={mySideNumber}
            onClearCell={onClearCell}
            clearDisabled={inputsLocked || cellDeleteMutation.isPending}
          />
        )}
      </div>

      <AlertDialog
        open={pendingClear !== null}
        onOpenChange={(open) => {
          if (!open) setPendingClear(null)
        }}
      >
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // A confirmed per-cell clear removed its own ✕ trigger; rather than
            // letting Radix restore focus to a detached node, put focus on the
            // first empty input so the user can keep typing.
            if (refocusAfterCloseRef.current) {
              refocusAfterCloseRef.current = false
              e.preventDefault()
              focusFirstEmpty()
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingClear === 'active' || pendingClear === null
                ? `Clear game ${gameNumber}?`
                : `Clear game ${pendingClear}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the saved score for this game. You can re-enter it
              afterwards.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep score</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={performClear}>
              Clear game
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <UnsavedScorePrompt
        open={status === 'blocked'}
        onLeave={proceed}
        onStay={reset}
      />
    </>
  )
}

// The in-app leave confirmation for unsaved score input. A design-system
// AlertDialog (not a bare confirm()), driven by the router blocker's resolver:
// "Leave" proceeds with the blocked navigation, "Stay" cancels it. Browser
// refresh/close is handled separately by the blocker's enableBeforeUnload.
function UnsavedScorePrompt({
  open,
  onLeave,
  onStay,
}: {
  open: boolean
  onLeave?: () => void
  onStay?: () => void
}) {
  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        // Dismissing via overlay/Esc is a "stay" — don't drop the score.
        if (!next) onStay?.()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            You've entered a score for this game but haven't saved it yet.
            Leaving now discards it.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onStay}>Keep editing</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={onLeave}>
            Discard &amp; leave
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// Surfaced when this game's save was rejected because a concurrent participant
// had already saved it. Shows the committed score alongside the user's rejected
// entry and makes them choose — the deliberate re-decision the version guard
// forces before any further write, so a stale entry can never silently clobber
// the committed result (the last-write-wins bug this whole change kills). A
// design-system Alert ("the app talking back"), loss-tinted to match SaveBanner.
function ScoreConflictNotice({
  meName,
  oppName,
  committedMe,
  committedOpp,
  yourMe,
  yourOpp,
  onKeepCommitted,
  onUseMine,
}: {
  meName: string
  oppName: string
  committedMe: number | null
  committedOpp: number | null
  yourMe: number | null
  yourOpp: number | null
  onKeepCommitted: () => void
  onUseMine: () => void
}) {
  const fmt = (value: number | null) => (value == null ? '—' : value)
  return (
    <Alert
      role="alert"
      variant="destructive"
      className="save-banner mb-4 border-[color:var(--loss)]/45 bg-[color:var(--loss)]/10"
    >
      <TriangleAlert aria-hidden />
      <AlertTitle>This game was saved by someone else.</AlertTitle>
      <AlertDescription className="text-[color:var(--fg-3)]">
        <span>
          Saved score:{' '}
          <strong className="text-[color:var(--fg-1)]">
            {meName} {fmt(committedMe)}–{fmt(committedOpp)} {oppName}
          </strong>
          . Your entry was {fmt(yourMe)}–{fmt(yourOpp)}. Keep the saved score, or
          replace it with yours.
        </span>
        <span className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
            onClick={onKeepCommitted}
          >
            Keep saved score
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
            onClick={onUseMine}
          >
            Replace with my score
          </Button>
        </span>
      </AlertDescription>
    </Alert>
  )
}

function Scoreline({
  data,
  activeGameNumber,
  decider,
  matchId,
  mySideNumber,
  onClearCell,
  clearDisabled,
}: {
  data: MatchDetails
  activeGameNumber: number
  /** The gap-tolerant decider game number (computed by the parent). Once a side
   * has clinched, the games numbered after it can never be played — those
   * unscored trailing cells render muted and non-navigable, so the user can't
   * enter an impossible "games past the decider" board. (An already-scored
   * trailing cell stays navigable so a pre-existing overrun board can be
   * cleared.) Mirrors the server guard. */
  decider: number | null
  matchId: string
  mySideNumber: 1 | 2
  onClearCell: (gameNumber: number) => void
  clearDisabled: boolean
}) {
  // Each cell observes its *own* save in the shared mutation cache (saving /
  // failed / saved), so the strip reflects per-game outcomes independently —
  // two failed saves light two cells, each retried and resolved on its own.
  // `--sl-cell-count` drives the mobile grid template so the cells fit exactly
  // the best-of width (the desktop layout flex-wraps regardless).
  return (
    <div className="scoreline">
      <div className="sl-label">SCORELINE</div>
      <div
        className="sl-cells"
        style={{ '--sl-cell-count': data.best_of } as React.CSSProperties}
      >
        {Array.from({ length: data.best_of }, (_, i) => i + 1).map((n) => {
          const game = data.games.find((x) => x.game_number === n) ?? null
          const playable =
            decider === null || n <= decider || game?.score != null
          return (
            <ScorelineCell
              key={n}
              n={n}
              matchId={matchId}
              score={game?.score ?? null}
              isActive={n === activeGameNumber}
              playable={playable}
              mySideNumber={mySideNumber}
              clearDisabled={clearDisabled}
              onClear={onClearCell}
            />
          )
        })}
      </div>
    </div>
  )
}

function ScorelineCell({
  n,
  matchId,
  score,
  isActive,
  playable,
  mySideNumber,
  clearDisabled,
  onClear,
}: {
  n: number
  matchId: string
  score: PersistedScore | null
  isActive: boolean
  playable: boolean
  mySideNumber: 1 | 2
  clearDisabled: boolean
  onClear: (gameNumber: number) => void
}) {
  const save = useGameSaveState(matchId, n)

  // A brief green confirmation when this game's save flips pending → success,
  // before the cell settles into its plain saved look — only on an actual
  // transition, so navigating onto a page whose game already saved doesn't
  // re-flash. Mirrors the design's saving → green-check → settle motion.
  const [resolved, setResolved] = useState(false)
  const prevStatus = useRef(save?.status)
  useEffect(() => {
    const previous = prevStatus.current
    prevStatus.current = save?.status
    if (previous === 'pending' && save?.status === 'success') {
      setResolved(true)
      const timer = setTimeout(() => setResolved(false), 900)
      return () => clearTimeout(timer)
    }
  }, [save?.status])

  // The active cell is the game being entered above — its inputs are the retry
  // surface, so it never wears a saving/failed/resolved treatment.
  const status = isActive ? null : (save?.status ?? null)
  const saving = status === 'pending'
  const failed = status === 'error'
  // A failure that's actually a concurrency conflict (opponent saved this game
  // first). Same ⚠ treatment as a plain failed save, but labelled "Changed" —
  // tapping it opens the edit screen, where the conflict notice lets the user
  // resolve it against the committed score rather than blindly re-saving.
  const conflict = failed && isScoreConflict(save?.error)
  const showResolved = resolved && status === 'success' && score != null

  // While saving or plainly failed, show the just-entered scratch points (the
  // retry surface). A *conflict* is different: our entry was rejected and the
  // committed score is someone else's — so show that committed value, not our
  // losing scratch, or the cell would present our rejected score as the live
  // result (the very confusion the conflict flow exists to prevent).
  const points =
    (saving || (failed && !conflict)) && save?.variables
      ? save.variables
      : score
        ? { side_1_points: score.side_1_points, side_2_points: score.side_2_points }
        : null
  const myPoints =
    points && (mySideNumber === 1 ? points.side_1_points : points.side_2_points)
  const oppPoints =
    points && (mySideNumber === 1 ? points.side_2_points : points.side_1_points)
  const isMyWin =
    score && !saving && !failed ? score.winner_side_number === mySideNumber : null

  const cls = cn(
    'sl-cell',
    isActive
      ? 'active'
      : saving
        ? 'saving'
        : failed
          ? 'failed'
          : showResolved
            ? 'resolved'
            : score
              ? 'done'
              : 'pending',
  )

  const badge = saving ? (
    <span className="sl-badge saving" aria-hidden>
      <Loader2 className="fmm-icon-spin" size={13} strokeWidth={2.25} />
    </span>
  ) : failed ? (
    <span className="sl-badge" aria-hidden>
      <TriangleAlert size={13} strokeWidth={2.25} />
    </span>
  ) : showResolved ? (
    <span className="sl-badge resolved" aria-hidden>
      <Check size={14} strokeWidth={3} />
    </span>
  ) : null

  const statusLabel = saving ? (
    <span className="sl-status saving" aria-hidden>
      Saving
    </span>
  ) : failed ? (
    <span className="sl-status failed" aria-hidden>
      {conflict ? 'Changed' : 'Not saved'}
    </span>
  ) : null

  // The ⚠ / spinner badge owns the cell's corner while saving or failed, so
  // the hover-✕ only shows on a plainly-saved cell.
  const clearBtn =
    score && !saving && !failed && !showResolved ? (
      <button
        type="button"
        className="sl-clear"
        aria-label={`Clear game ${n}`}
        title={`Clear game ${n}`}
        disabled={clearDisabled}
        onClick={(e) => {
          // Stop the surrounding Link from navigating to /edit on the cell we
          // just cleared. preventDefault is what blocks TanStack Router's nav
          // (it checks defaultPrevented before dispatching) — stopPropagation
          // is belt-and-suspenders.
          e.preventDefault()
          e.stopPropagation()
          onClear(n)
        }}
      >
        <XIcon size={14} strokeWidth={2.5} aria-hidden />
      </button>
    ) : null

  const inner = (
    <>
      {badge}
      <div className="sl-n">G{n}</div>
      <div className="sl-scores">
        <span className={cn('s', isMyWin === true && 'w')}>
          {myPoints ?? '—'}
        </span>
        <span className="dash">–</span>
        <span className={cn('s', isMyWin === false && 'w')}>
          {oppPoints ?? '—'}
        </span>
      </div>
      {statusLabel}
      {clearBtn}
    </>
  )

  if (isActive) {
    return (
      <div className={cls} aria-current="step">
        {inner}
      </div>
    )
  }

  // A save in flight isn't a navigation target — wait for it to settle.
  if (saving) {
    return (
      <div
        className={cls}
        aria-label={`Game ${n}, saving, ${myPoints} to ${oppPoints}`}
      >
        {inner}
      </div>
    )
  }

  // Past the decider: the match was already won, so this game can't be played.
  // Render muted and non-navigable (only ever reached for an unscored cell —
  // a scored cell stays playable so a stray board can be cleared).
  if (!playable) {
    return (
      <div
        className={cn(cls, 'unplayable')}
        aria-disabled="true"
        aria-label={`Game ${n}, not playable`}
      >
        {inner}
      </div>
    )
  }

  const target = score ? scoringEditRoute(matchId, n) : scoringNewRoute(matchId, n)
  // Failure can't be color-alone: the label spells it out for screen readers;
  // sighted users get the ⚠ badge + "Not saved" / "Changed" micro-label.
  const ariaLabel = conflict
    ? `Game ${n} was saved by someone else as ${myPoints} to ${oppPoints}. Tap to review.`
    : failed
      ? `Game ${n} didn't save, ${myPoints} to ${oppPoints}. Tap to fix.`
      : score
        ? `Game ${n}, saved, ${myPoints} to ${oppPoints}`
        : `Game ${n}, not yet played`
  return (
    <Link {...target} className={cls} aria-label={ariaLabel}>
      {inner}
    </Link>
  )
}
