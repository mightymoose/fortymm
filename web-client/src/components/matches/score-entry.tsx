import { useEffect, useRef, useState } from 'react'
import {
  Link,
  Navigate,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  Loader2,
  TriangleAlert,
  User as UserIcon,
  X as XIcon,
} from 'lucide-react'
import { ApiError } from '@/api/client'
import {
  forgetScoreSaves,
  matchDetailRoute,
  recordedGameNumbers,
  scoringEditRoute,
  scoringNewRoute,
  useDeleteScore,
  useDeleteScoreForMatch,
  useFinalizeMatch,
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
import { decidedSide, illegalScoreReason } from '@/lib/scoring'
import { isScoreConflict, useGameSaveState } from './score-saves'
import { SaveBanner } from './save-banner'

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
  const finalizeMutation = useFinalizeMatch(matchId)
  // This game's own latest save state, read from the shared mutation cache —
  // used only to pre-fill the inputs after a failed save (the scoreline cells
  // and banner each read their own state).
  const ownSave = useGameSaveState(matchId, gameNumber)

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
  // blocker only reads it. `submittingRef` is flipped just before the
  // fire-and-forget Save (or an explicit Clear) navigates so that intentional
  // hop is never blocked; it's a ref since it's read inside the blocker
  // callbacks, not rendered.
  const [isDirty, setIsDirty] = useState(false)
  const submittingRef = useRef(false)
  const { status, proceed, reset } = useBlocker({
    // Blocks browser refresh/close (beforeunload) only while genuinely dirty.
    enableBeforeUnload: () => isDirty,
    // Blocks in-app route changes the same way — but never the Save hop.
    shouldBlockFn: () => isDirty && !submittingRef.current,
    withResolver: true,
  })

  if (isLoading || !data) {
    return (
      <>
        <div aria-busy="true" data-testid="score-entry-loading" />
      </>
    )
  }

  // The scoring screen is participant-only; spectators bounce back to the
  // read-only details page. The opponent side is always present — a real
  // player, or the player-less placeholder for solo matches.
  const mySide = data.sides.find((s) => s.is_current_user_side) ?? null
  const oppSide = data.sides.find((s) => !s.is_current_user_side) ?? null
  if (!mySide || !oppSide) {
    return <Navigate {...matchDetailRoute(matchId)} />
  }

  // Once a match is finalized every write path 409s — there's nothing to do
  // here. Same goes once a result is posted and waiting on confirmation —
  // scores are frozen until /confirmation or /dispute lands, and either
  // option lives on the match-details page.
  if (data.status === 'completed' || data.signatures.length > 0) {
    return <Navigate {...matchDetailRoute(matchId)} />
  }
  if (
    !Number.isInteger(gameNumber) ||
    gameNumber < 1 ||
    gameNumber > data.best_of
  ) {
    return <Navigate {...matchDetailRoute(matchId)} />
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
    return <Navigate {...scoringEditRoute(matchId, gameNumber)} replace />
  }
  if (mode.kind === 'edit' && !persistedScore) {
    return <Navigate {...scoringNewRoute(matchId, gameNumber)} replace />
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

  // Take the typed value verbatim — no stripping, no truncating. We only block
  // characters that can't begin a score (letters, sign) so non-numeric input
  // stays rejected as before; digits and a "." are kept. Earlier we stripped
  // non-digits and capped at 3, but that quietly turned "11.5" into "115" and
  // "999999" into "999" — plausible-looking scores the user never typed (#624).
  // Keeping the raw text lets a malformed entry stay visible and get flagged
  // inline (see `formatError`) instead of masquerading as a real score.
  const isAcceptable = (value: string) => !/[^\d.]/.test(value)
  const onMeChange = (value: string) => {
    if (!isAcceptable(value)) return
    setMeTyped(value)
    setIsDirty(computeDirty(value, opp))
    if (finalizeMutation.error) finalizeMutation.reset()
  }
  const onOppChange = (value: string) => {
    if (!isAcceptable(value)) return
    setOppTyped(value)
    setIsDirty(computeDirty(me, value))
    if (finalizeMutation.error) finalizeMutation.reset()
  }

  const bothFilled = me !== '' && opp !== ''
  // Exactly one side filled: the Save button is disabled, so without a word
  // it's a dead end with no explanation (#387). Tell the user both scores are
  // required and flag the still-empty field. Only after the user has started
  // typing — a wholly-empty pair is the untouched initial state, not an error.
  const oneSideFilled = (me !== '') !== (opp !== '')
  // A filled side is well-formed only as 1–3 digits. Since the inputs are no
  // longer coerced (#624), a decimal ("11.5") or an over-long run ("999999")
  // reaches here verbatim — caught as a format error rather than silently
  // becoming "115"/"999". Flagged on its own, before the both-filled scoring
  // check, so it surfaces the moment the bad side is typed.
  const meMalformed = me !== '' && !/^\d{1,3}$/.test(me)
  const oppMalformed = opp !== '' && !/^\d{1,3}$/.test(opp)
  const formatError =
    meMalformed || oppMalformed
      ? 'Enter each score as a whole number from 0 to 999.'
      : null
  const localScoreError =
    formatError ??
    (bothFilled ? illegalScoreReason(Number(me), Number(opp)) : null)
  const inputsValid = bothFilled && localScoreError === null

  // Build the hypothetical full-match games list including the current input,
  // so we can ask the scoring lib whether saving this entry would make the
  // match finalize-able. If so, the single submit button swaps to "Finalize
  // match" and posts /results instead of /scores/new.
  const hypotheticalGames: MatchResultsGameWrite[] = inputsValid
    ? [
        ...data.games
          .filter((g) => g.game_number !== gameNumber && g.score)
          .map((g) => ({
            game_number: g.game_number,
            side_1_points: g.score!.side_1_points,
            side_2_points: g.score!.side_2_points,
          })),
        mySideNumber === 1
          ? {
              game_number: gameNumber,
              side_1_points: Number(me),
              side_2_points: Number(opp),
            }
          : {
              game_number: gameNumber,
              side_1_points: Number(opp),
              side_2_points: Number(me),
            },
      ]
    : []
  const wouldFinalize =
    inputsValid && decidedSide(hypotheticalGames, bestOf) !== null

  // Per the fire-and-forget posture: only finalize errors are surfaced. The
  // per-game mutations (save / delete) self-heal at finalize, so their errors
  // are intentionally hidden here (surfaced in the scoreline instead). All
  // finalize errors surface, not just 422 validation drift — for a deciding
  // game this button is the sole finalize path (the banner is informational),
  // so a 409 "already posted" / 500 must be visible here rather than swallowed.
  const finalizeApiError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null
  // The score *inputs* are only invalid for genuine validation problems (local
  // illegal score, or a 422 drift the server rejected) — a 409/500 means the
  // entered score is fine, so don't paint the fields red for those.
  const inputsInvalid =
    localScoreError !== null || finalizeApiError?.status === 422
  // The message line, though, surfaces every finalize error (409/500 included).
  const showScoreError = inputsInvalid || finalizeApiError !== null
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
    // Ignore a second Save while the per-game save is still in flight (#538):
    // a double-tap would otherwise fire a duplicate create that 409s. This
    // synchronous guard is the only protection now — the mutationFn no longer
    // swallows that 409 (it would surface as a conflict to review), so don't
    // let a double-tap reach it.
    if (saveMutation.isPending) return
    // Same for a second submit while the finalize POST is in flight (#550). The
    // submit button's `disabled` is only a render-time guard, so a fast
    // double-click can land a second tap before React commits it — fire one
    // POST /results, not two (the second 409s on the already-posted result).
    if (finalizeMutation.isPending) return
    // This is the sanctioned write path: any navigation it triggers (the
    // synchronous next-game hop, or finalize's onSuccess to the match page)
    // is intentional, so wave the unsaved-input blocker through it (#441).
    submittingRef.current = true
    // Finalizing posts the canonical result — but that's the one write that
    // can't be faked offline. When offline we instead fall through to the
    // scratchpad save below, which stores the deciding game's score in the
    // mutation cache (visible as a failed cell) so it survives until the user
    // can post the result back online. Online, finalize as usual.
    if (wouldFinalize && onlineManager.isOnline()) {
      finalizeMutation.mutate(
        { games: hypotheticalGames },
        { onSuccess: () => navigate(matchDetailRoute(matchId)) },
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
    navigate(next)
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
    if (target === 'active') {
      if (mode.kind !== 'edit') return
      // Clearing is an explicit discard — drop any failed-save leftovers too,
      // so a stale failure doesn't outlive the score it referred to. The
      // edit→new hop it triggers is intentional, so the unsaved-input blocker
      // stays out (#441).
      submittingRef.current = true
      forgetScoreSaves(queryClient, matchId, gameNumber)
      deleteMutation.mutate(undefined, {
        // After clearing, land back on this game's create route so the user
        // can re-enter — same page, just with empty inputs and create-mode
        // semantics. The remount's autoFocus puts focus on the me-input,
        // which is the first empty input.
        onSettled: () => navigate(scoringNewRoute(matchId, gameNumber)),
      })
      return
    }
    // Per-cell ✕ — clears the score for any logged game from the scoreline
    // strip. We refocus the first empty input on the current page so the user
    // can keep typing (deferred to the dialog's close-focus hook).
    forgetScoreSaves(queryClient, matchId, target)
    cellDeleteMutation.mutate(target)
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
    // against the value we just showed them.
    submittingRef.current = true
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
      ? 'This score finishes the match — submitting posts the result for your opponent to confirm.'
      : 'This score finishes the match — submitting will finalize the result immediately.'
    : isEdit
      ? 'Save updates the score for this game.'
      : gameNumber < bestOf
        ? `Save this game to continue to game ${gameNumber + 1}.`
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
        : 'Save final game →'

  return (
    <>
      <div className="entry-wrap">
        <div className="entry-head">
          <h2>{heading}</h2>
          <div className="hint">
            Type <kbd>0</kbd>–<kbd>9</kbd> &nbsp;·&nbsp; <kbd>Enter</kbd> for
            next / save game
          </div>
        </div>

        <SaveBanner matchId={matchId} activeGameNumber={gameNumber} />

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

        <div className="single-entry">
          <ScoreSide
            side="me"
            name={meName}
            initials={meInitials}
            value={me}
            inputRef={meRef}
            autoFocus
            disabled={inputsLocked}
            invalid={meInvalid}
            onChange={onMeChange}
            onKeyDown={(e) => handleKey(e, 'me')}
          />

          <div className="se-mid">
            <div className="se-vs">VS</div>
            {/* Single-game matches: the games tally is always 0–0 until the one
                game finalizes, so it's noise — drop it (#bridge-cse). */}
            {bestOf > 1 && (
              <div className="se-games">
                {meWins} – {oppWins}
              </div>
            )}
          </div>

          <ScoreSide
            side="opp"
            name={oppName}
            initials={oppHasPlayer ? initialsOf(oppName) : null}
            value={opp}
            inputRef={oppRef}
            disabled={inputsLocked}
            invalid={oppInvalid}
            onChange={onOppChange}
            onKeyDown={(e) => handleKey(e, 'opp')}
          />
        </div>

        {showScoreError && (
          <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
            {localScoreError ??
              finalizeApiError?.detail ??
              finalizeApiError?.message}
          </p>
        )}
        {showBothRequired && (
          <p role="alert" className="mt-1.5 text-xs text-[color:var(--loss)]">
            Enter both scores to save this game.
          </p>
        )}

        <div className="single-actions">
          <div className="result-line subtle">{subtitle}</div>
          <div className="action-btns">
            {isEdit && (
              <button
                type="button"
                className="btn ghost"
                onClick={onClear}
                disabled={inputsLocked || deleteMutation.isPending}
              >
                Clear
              </button>
            )}
            <button
              type="button"
              className="btn primary"
              disabled={!inputsValid || inputsLocked}
              // Don't let tapping Save blur the active input: on mobile that
              // dismisses the soft keyboard before the synchronous navigation
              // can hand focus to the next game's input, closing the keyboard
              // between games (#567). Preventing the mousedown default keeps
              // focus on the input through the tap; the click still fires.
              onMouseDown={(e) => e.preventDefault()}
              onClick={onSubmit}
            >
              {submitLabel}
            </button>
          </div>
        </div>

        <Scoreline
          data={data}
          activeGameNumber={gameNumber}
          matchId={matchId}
          mySideNumber={mySideNumber}
          onClearCell={onClearCell}
          clearDisabled={inputsLocked || cellDeleteMutation.isPending}
        />
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

function ScoreSide({
  side,
  name,
  initials,
  value,
  inputRef,
  autoFocus,
  disabled,
  invalid,
  onChange,
  onKeyDown,
}: {
  side: 'me' | 'opp'
  name: string
  // `null` means there's no player on this side — render the ghost avatar
  // (dashed circle + person icon) instead of a contrived monogram.
  initials: string | null
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  disabled: boolean
  invalid: boolean
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const noPlayer = initials === null
  const avatar = (
    <div className="av" aria-hidden={noPlayer || undefined}>
      {noPlayer ? <UserIcon size={20} strokeWidth={1.75} /> : initials}
    </div>
  )
  const identity = (
    <div className="id">
      <div className="nm">{name}</div>
    </div>
  )

  return (
    <div className={cn('se-side', side, noPlayer && 'no-opponent')}>
      <div className={cn('se-head', side === 'opp' && 'right')}>
        {side === 'opp' && identity}
        {avatar}
        {side === 'me' && identity}
      </div>
      <input
        ref={inputRef}
        className="big-input"
        type="text"
        inputMode="numeric"
        aria-label={`${name} score`}
        aria-invalid={invalid || undefined}
        placeholder="0"
        value={value}
        autoFocus={autoFocus}
        disabled={disabled}
        onFocus={(e) => e.target.select()}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}

function Scoreline({
  data,
  activeGameNumber,
  matchId,
  mySideNumber,
  onClearCell,
  clearDisabled,
}: {
  data: MatchDetails
  activeGameNumber: number
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
          return (
            <ScorelineCell
              key={n}
              n={n}
              matchId={matchId}
              score={game?.score ?? null}
              isActive={n === activeGameNumber}
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
  mySideNumber,
  clearDisabled,
  onClear,
}: {
  n: number
  matchId: string
  score: PersistedScore | null
  isActive: boolean
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
      <Loader2 className="sl-spin" size={13} strokeWidth={2.25} />
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
