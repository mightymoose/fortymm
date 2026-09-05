import { useEffect, useRef, useState } from 'react'
import { zodResolver } from '@hookform/resolvers/zod'
import { useController, useForm } from 'react-hook-form'
import {
  Link,
  Navigate,
  useBlocker,
  useNavigate,
} from '@tanstack/react-router'
import { onlineManager, useQueryClient } from '@tanstack/react-query'
import { Check, Loader2, TriangleAlert, X as XIcon } from 'lucide-react'
import { ApiError, isNegotiationConflict } from '@/api/client'
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
import { orderedSides } from './match-details/ordered-sides'
import { NOT_SCORABLE_REASON_COPY } from './not-scorable-reason-copy'
import { reconstructBoard, scoredGamePoints } from './reconstruct-board'
import {
  isScoreConflict,
  useFailedGameSaves,
  useGameSaveState,
} from './score-saves'
import { SaveBanner } from './save-banner'
import { ScorePad } from './score-pad'
import { isAcceptableScoreInput } from './score-pad/validate-game-score'
import {
  gameScoreSchema,
  type GameScoreInput,
} from './score-pad/game-score-schema'
import { mapGameScoreValidation } from './score-pad/game-score-ui'

/** The non-null persisted score on a game. */
type PersistedScore = NonNullable<MatchDetails['games'][number]['score']>

/**
 * The baseline `{ me, opp }` the inputs read with no local typing — the failed
 * scratch save, else the persisted score, else empty (#624 keeps everything a
 * clean digit string, or empty). Seeds React Hook Form's `values` (ADR-0018), so
 * the form is initialised from the same source the dirty baseline below computes.
 * Computed at the top of the component (before the loading guard) where the
 * derived `persistedMe`/`failedMe` aren't in scope yet; the render body recomputes
 * the same baseline for the dirty check and the conflict notice.
 *
 * The left-hand slot ("me") is the viewer's own side when they're a
 * participant, else the neutral `orderedSides` first side (side 1) for a
 * director scoring a match they don't play in (#1523) — this must stay the
 * SAME first-side pick the render body uses below, or the seed and the write
 * orientation (`toBody`) would disagree about which side is which.
 */
function seedScoreValues(
  data: MatchDetails,
  gameNumber: number,
  ownSave: ReturnType<typeof useGameSaveState>,
): GameScoreInput {
  const [firstSide] = orderedSides(data)
  if (!firstSide) return { me: '', opp: '' }
  const mySideNumber: 1 | 2 = firstSide.side_number === 2 ? 2 : 1
  const persistedScore =
    data.games.find((g) => g.game_number === gameNumber)?.score ?? null
  const persistedMe = persistedScore
    ? mySideNumber === 1
      ? persistedScore.side_1_points
      : persistedScore.side_2_points
    : null
  const persistedOpp = persistedScore
    ? mySideNumber === 1
      ? persistedScore.side_2_points
      : persistedScore.side_1_points
    : null
  const failedEntry = ownSave?.status === 'error' ? ownSave.variables : null
  const failedMe = failedEntry
    ? mySideNumber === 1
      ? failedEntry.side_1_points
      : failedEntry.side_2_points
    : null
  const failedOpp = failedEntry
    ? mySideNumber === 1
      ? failedEntry.side_2_points
      : failedEntry.side_1_points
    : null
  return {
    me:
      failedMe != null
        ? String(failedMe)
        : persistedMe != null
          ? String(persistedMe)
          : '',
    opp:
      failedOpp != null
        ? String(failedOpp)
        : persistedOpp != null
          ? String(persistedOpp)
          : '',
  }
}

// Placeholder for the opponent label on solo matches — mirrors the match
// details hero. Distinct from `initialsOf('Opponent')` so users can tell
// "no opponent" apart from a real two-letter monogram.
const NO_OPPONENT_LABEL = 'No opponent'

/**
 * `not_scorable_reason` is match-relative, not viewer-relative, so it's
 * `null` even for a spectator on an otherwise scorable match — that's the
 * one case with no server reason to mirror, and gets its own plain
 * participant-only explanation instead. The four real reasons' copy lives in
 * `NOT_SCORABLE_REASON_COPY` (`./not-scorable-reason-copy`), shared with the
 * call-status banner (#1288) so a copy edit can't drift the two apart.
 */
function scoreEntryRefusalMessage(
  notScorableReason: MatchDetails['not_scorable_reason'],
): string {
  if (notScorableReason === null) {
    return 'Only participants in this match can enter scores.'
  }
  // Runtime-total fallback: `useMatch`/`matchQueryOptions` casts its payload
  // without a Zod parse (unlike the `matchDetailsQuery` boundary point 1
  // hardens), so a value outside `NOT_SCORABLE_REASON_COPY`'s keys is only a
  // type-checked impossibility for callers inside `src/`, not a runtime
  // guarantee. Same copy as the no-participation case — a safe, honest
  // default.
  return (
    NOT_SCORABLE_REASON_COPY[notScorableReason] ??
    'Only participants in this match can enter scores.'
  )
}

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
  // This game's committed version as of THIS render — read at the top,
  // before the loading guard, the same way `seedScoreValues` reads the
  // persisted score early (see its own comment). Feeds the frozen-baseline
  // resync below; the render body re-derives the same value further down
  // (as part of `persistedScore`) once it's back in scope.
  const topPersistedVersion =
    data?.games.find((g) => g.game_number === gameNumber)?.score?.version ??
    null
  const topPersistedId =
    data?.games.find((g) => g.game_number === gameNumber)?.score?.id ?? null
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
  //
  // Declared here, ahead of `freshSeed`/`baseline` below, because the frozen
  // baseline's render-time resync reads it — hooks must all be declared before
  // any early return, but a plain `useState` has no ordering dependency on
  // anything else, so moving it up is free.
  const [isDirty, setIsDirty] = useState(false)
  const [isReplacing, setIsReplacing] = useState(false)
  const replacingRef = useRef(false)

  // The fresh seed as of THIS render — failed scratch → persisted → empty
  // (`seedScoreValues`'s own comment). NOT what the form reads directly: see
  // `baseline` immediately below, which freezes this while the page is dirty.
  const freshSeed = data ? seedScoreValues(data, gameNumber, ownSave) : null

  // The frozen baseline: what RHF's `values` actually feeds the inputs, what
  // `computeDirty` measures typing against, and (via its `version`) what a
  // live conflict (#1661 item 6) compares the committed score to. Tracked in
  // component state, not read fresh from `data`/`ownSave` on every render — it
  // must hold BOTH fields steady together while the page is dirty.
  //
  // This is the fix for a real bug: RHF's `values` + `keepDirtyValues` only
  // preserves a field the user actually TYPED IN — per field, not per form. A
  // player who edits only the opponent's score (leaving "me" untouched) has a
  // "me" field RHF considers clean, so a background refetch that changes the
  // committed score silently re-seeds "me" alone, out from under a dirty page,
  // while "opp" stays as typed. The conflict notice then read a Frankenstein
  // pair — the fresh committed "me" next to the player's own typed "opp" — as
  // if the player had typed both. Freezing the SOURCE (`baseline`, not RHF's
  // per-field bookkeeping) fixes it at the root: while dirty, `values` never
  // changes at all, so RHF has nothing to reset either field from.
  //
  // Resynced HERE, during render, rather than in a `useEffect` — an effect
  // would commit the stale baseline for one extra frame (a `liveConflict`
  // false-positive on the very refetch that should be resyncing quietly) and
  // trips `react-hooks/set-state-in-effect` besides. This is React's
  // documented "adjust state during render" pattern (an idempotent update: it
  // only fires when a value actually needs to move, converging in the same
  // pass rather than looping) — the same shape as the inputs' own seeding used
  // to be. Once `isDirty` is true this stops updating, so the WHOLE pair holds
  // steady together until the user explicitly resolves the conflict
  // (`keepCommittedScore` / `overwriteWithMyScore`, both of which clear
  // `isDirty` and let this resync on the very next render).
  const [baseline, setBaseline] = useState<{
    me: string
    opp: string
    version: number | null
    scoreId: string | null
  }>(() => ({
    me: freshSeed?.me ?? '',
    opp: freshSeed?.opp ?? '',
    version: topPersistedVersion,
    scoreId: topPersistedId,
  }))
  if (
    !isDirty &&
    freshSeed &&
    (baseline.me !== freshSeed.me ||
      baseline.opp !== freshSeed.opp ||
      baseline.version !== topPersistedVersion ||
      baseline.scoreId !== topPersistedId)
  ) {
    setBaseline({
      me: freshSeed.me,
      opp: freshSeed.opp,
      version: topPersistedVersion,
      scoreId: topPersistedId,
    })
  }

  // React Hook Form owns the two score fields and their Zod validation — and
  // nothing else (ADR-0018). Its `values` are the FROZEN `baseline` above, not
  // a fresh recompute — see that declaration for why. The frozen baseline
  // protects both fields while dirty. Do not also keep RHF's dirty values:
  // those flags can outlive a successful save and would retain stale inputs
  // when a clean page receives the next score. `keepSubmitCount` keeps the
  // errors-after-first-submit gate from silently resetting when a background
  // refetch changes the baseline mid-edit.
  //
  // `mode: 'onSubmit'` + `reValidateMode: 'onChange'`: nothing is red while the
  // user first types; the first submit surfaces the errors; thereafter they
  // re-validate live so a fix clears the red. The submit button is NEVER gated
  // on validity (ADR-0018) — `handleSubmit` is the only gate, an invalid submit
  // fires nothing.
  const form = useForm<GameScoreInput>({
    resolver: zodResolver(gameScoreSchema),
    mode: 'onSubmit',
    reValidateMode: 'onChange',
    defaultValues: { me: '', opp: '' },
    values: data ? { me: baseline.me, opp: baseline.opp } : undefined,
    resetOptions: {
      keepSubmitCount: true,
      keepIsSubmitted: true,
    },
  })
  // Each side is driven through a controller so the #624 keystroke filter
  // (`isAcceptableScoreInput`) can reject a change outright — the value never
  // updates — while RHF still owns the field. `useController` already subscribes
  // to its field, so the live value is read straight off `field.value` (no
  // separate `useWatch`), and every downstream consumer (dirty tracking, finalize
  // prediction, `overrunAt`, `toBody`, the copy, the scoreline) reads it.
  const meField = useController({ control: form.control, name: 'me' })
  const oppField = useController({ control: form.control, name: 'opp' })
  const me = meField.field.value ?? ''
  const opp = oppField.field.value ?? ''
  const submitted = form.formState.submitCount > 0
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

  // Computed before the `isLoading`/`data` guard below because it only reads
  // `finalizeMutation` (a hook value, already in scope) — needed early so the
  // negotiation-conflict redirect guard right after that can run ahead of
  // #1288's generic `can_score` refusal.
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
  // The NEGOTIATION-conflict 409 ("a result already exists") is not an error to
  // fix here — the opponent already posted the standing result. `useProposeResult`
  // refetches the match on this 409; once the fresh data lands, the
  // early-return guard below navigates to match detail (where the poster can
  // Accept). Until that one-round-trip refetch resolves we're in a transient
  // redirect window: show CALM "taking you there" copy instead of the red
  // "Failed" error, and don't paint the valid inputs red. This is the minimal
  // Option A that replaces the #800 reconcile interstitial ADR-0005 (#827)
  // removed.
  //
  // Only the negotiation-conflict 409 redirects. The other propose 409s carry a
  // plain-STRING detail — the lock race ("a result is already being posted…") and
  // the terminal guard ("no longer open to results") — and their concurrent post
  // may not have committed, so a refetch could leave `standing_result` null and
  // strand the screen on "Taking you there…" forever. Those fall through to the
  // normal red-error path below (string detail rendered, submit live for retry),
  // exactly as before this fix.
  const finalizeRedirecting =
    finalizeApiError !== null && isNegotiationConflict(finalizeApiError)

  if (isLoading || !data) {
    return (
      <>
        <div aria-busy="true" data-testid="score-entry-loading" />
      </>
    )
  }

  // The `<Navigate>` guard redirects below are all app-initiated: each is
  // computed purely from server data with no user gesture, so each bypasses the
  // unsaved-input blocker via `ignoreBlocker`. Foot-gun: omitting it doesn't
  // merely prompt — a blocked `<Navigate>` re-fires and wedges the screen. See
  // ADR 0014 (#818) for the spin mechanism.

  // The negotiation-conflict redirect (#827/#800, see `finalizeRedirecting`
  // above): the viewer's own propose/finalize just 409'd because the
  // opponent's result won the race, and the refetch it triggers has now
  // confirmed the standing result (or a completed match). This is narrower
  // than, and takes priority over, #1288's generic `can_score` refusal below —
  // it's gated on the viewer's OWN finalize attempt, not on bare match state,
  // so a match that becomes non-scorable for any other reason (someone else's
  // action, a stale link, an uncalled fixture) falls through to that guard
  // and gets the inline explanation instead of this silent bounce.
  if (
    finalizeRedirecting &&
    (data.status === 'completed' || data.negotiation.standing_result !== null)
  ) {
    return <Navigate {...matchDetailRoute(matchId)} ignoreBlocker />
  }

  // Refuse at the boundary and explain why, rather than letting the user
  // fill out a form the write path would 409/422 on (#1288's client-side
  // mirror of `ensure_scorable`). Not a `<Navigate>`, so it also catches a
  // spectator (`can_score: false` with `not_scorable_reason: null`, since
  // that reason is match-relative, not viewer-relative) with an explanation
  // instead of a silent bounce. `can_score` is also true for the tournament
  // director on a called, unresolved match in their own tournament, even when
  // they hold no side (#1523), so a director on a scorable match falls
  // through this guard same as a participant. The completed/posted-result
  // case above already returned, so what's left here is: not yet called, no
  // opponent, or some other terminal state (e.g. voided) — plus a spectator
  // on a match none of those apply to.
  if (!data.can_score) {
    return (
      <div className="entry-wrap">
        <Alert variant="destructive" className="mb-3">
          <TriangleAlert aria-hidden />
          <AlertTitle>Can't enter a score here</AlertTitle>
          <AlertDescription>
            {scoreEntryRefusalMessage(data.not_scorable_reason)}
          </AlertDescription>
        </Alert>
      </div>
    )
  }

  // The perspective pair: the viewer's own side first when they're a
  // participant (unchanged), else side 1 / side 2 in order (`ordered-sides.ts`,
  // shared with the players panel / scoreboard) for the director's neutral
  // view. Both must resolve — a match not shaped like a real two-sided match
  // still bounces out rather than rendering a half-built board.
  const [firstSide, secondSide] = orderedSides(data)
  if (!firstSide || !secondSide) {
    return <Navigate {...matchDetailRoute(matchId)} ignoreBlocker />
  }
  // `can_score` above already guarantees the viewer is authorized — a
  // participant OR the tournament's director (#1523) — on this scorable,
  // two-sided match. `orderedSides` puts the viewer's own side first when
  // they're a participant, so `!firstSide.is_current_user_side` identifies
  // the director's neutral, side-number-ordered view instead of the
  // participant's "me/opp" perspective.
  const isDirectorView = !firstSide.is_current_user_side

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

  // The scratchpad is contiguous (ADR "the scratchpad is contiguous", #1661
  // item 5): a create-mode entry for a game past an unsaved earlier one is
  // refused at the boundary, in the server's own words, before the player
  // ever sees inputs the write would 422 on. Edit mode never reaches here —
  // it requires a persisted score for THIS game, and editing an earlier game
  // in place never creates a gap.
  //
  // "Unsaved" here counts a game the SAME way `predictNextScoringRoute`
  // below does: persisted OR sitting in the mutation cache as a pending/
  // failed scratch save. The offline flow deliberately lets a player advance
  // through every game even though each individual write failed (the
  // fire-and-forget posture — a failed scratch is still an attempt, retried
  // from the scoreline/banner) — this guard exists to catch a game nobody has
  // touched at all, not to re-litigate that design.
  if (mode.kind === 'create') {
    const recorded = recordedGameNumbers(queryClient, matchId)
    let firstUnsaved: number | null = null
    for (let n = 1; n < gameNumber; n += 1) {
      if (!isScored(n) && !recorded.has(n)) {
        firstUnsaved = n
        break
      }
    }
    if (firstUnsaved !== null) {
      return (
        <div className="entry-wrap">
          <Alert variant="destructive" className="mb-3">
            <TriangleAlert aria-hidden />
            <AlertTitle>Can't enter a score here</AlertTitle>
            <AlertDescription>
              {`Save game ${firstUnsaved} before game ${gameNumber}.`}
            </AlertDescription>
          </Alert>
        </div>
      )
    }
  }

  const game = data.games.find((g) => g.game_number === gameNumber) ?? null
  const persistedScore = game?.score ?? null

  // A dirty page whose committed version has moved since the baseline was
  // seeded (#1661 item 6) — a score appeared where the page held none, or the
  // committed score changed under a typed-but-unsaved entry. Gates the
  // mode-swap redirects below: while this is true the user has a real
  // decision to make (the live conflict notice, rendered further down), and
  // navigating out from under them would silently discard their typing and
  // hide the very state they need to see.
  const versionDiffered =
    (ownSave?.status === 'error' && isScoreConflict(ownSave.error)) ||
    (isDirty &&
      (baseline.version !== (persistedScore?.version ?? null) ||
        baseline.scoreId !== (persistedScore?.id ?? null)))

  // Mode/URL/state alignment: in create mode but a score exists → swap to
  // the edit URL so Save doesn't try to POST .../scores/new and 409. The
  // inverse — edit mode but no saved score — swaps to the create URL.
  // Skipped while this page's own save is settling: the success cache
  // write makes the score "exist" a beat before onSettled navigates to the
  // next game, and this redirect must not outrun that navigation.
  if (
    mode.kind === 'create' &&
    persistedScore &&
    !saveMutation.isSuccess &&
    !versionDiffered
  ) {
    return (
      <Navigate {...scoringEditRoute(matchId, gameNumber)} replace ignoreBlocker />
    )
  }
  if (mode.kind === 'edit' && !persistedScore && !versionDiffered) {
    return (
      <Navigate {...scoringNewRoute(matchId, gameNumber)} replace ignoreBlocker />
    )
  }

  const mySideNumber: 1 | 2 = firstSide.side_number === 2 ? 2 : 1
  const oppUsername = secondSide.players[0]?.username ?? null
  const oppName = oppUsername ?? NO_OPPONENT_LABEL
  // A director names both sides by player — no "you" framing — so the first
  // slot falls back to the same "No opponent" placeholder as the second
  // rather than defaulting to "You" (#1523). A participant keeps the
  // unchanged "You" fallback (defensive only: their own side always carries
  // their own player).
  const meName =
    firstSide.players[0]?.username ?? (isDirectorView ? NO_OPPONENT_LABEL : 'You')
  const meInitials = initialsOf(meName)
  const oppHasPlayer = oppUsername !== null

  const bestOf = data.best_of
  const meWins = firstSide.games_won
  const oppWins = secondSide.games_won
  // The highest-numbered game with a committed score — the only one the
  // scratchpad's contiguity rule (#1661 item 5) offers a Clear for, in-page
  // or from a scoreline cell. Clearing anything earlier would leave a gap
  // under a later saved game (the server's own 422: "Clear game M first, or
  // edit game N instead."); an earlier game stays editable, just not
  // clearable.
  const highestSavedGame = data.games.reduce(
    (max, g) => (g.score ? Math.max(max, g.game_number) : max),
    0,
  )

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

  // The SAME notice, reached a different way (#1661 item 6): the committed
  // score for this game moved out from under a dirty page with no save of
  // its own ever attempted — `versionDiffered`, minus the `conflict` case
  // above (which already has its own, save-driven story to tell — a rejected
  // write). This is the pushed-hint refetch landing on a page the viewer is
  // still typing into: nothing has been sent, so there's nothing to retry,
  // only a choice to make against the fresh committed value.
  const liveConflict = versionDiffered && !conflict
  // Either conflict shows the SAME notice; only the "your entry" side reads
  // from a different source — the rejected scratch save's variables for a
  // real 409, or the live, still-unsaved input for a background one.
  const noticeYourMe = conflict ? (failedMe ?? null) : me !== '' ? Number(me) : null
  const noticeYourOpp = conflict
    ? (failedOpp ?? null)
    : opp !== ''
      ? Number(opp)
      : null

  // The baseline is what the inputs read with no local typing — the FROZEN
  // `baseline` state above (failed scratch → persisted → empty, as of the
  // last render the page was clean on), which is also exactly what RHF's
  // `values` fed the inputs. Input is "dirty" (worth guarding on exit) only
  // when the user has actually typed something that diverges from that
  // baseline: a clean page, or input that merely matches what's already
  // saved, must not nag.
  //
  // Reading the FROZEN `baseline` here — not a fresh `seedScoreValues(data, …)`
  // recompute — is what keeps this agreeing with what's on screen once the
  // page is dirty: a fresh recompute would measure new keystrokes against a
  // baseline that had already silently moved (the bug this fix closes), even
  // though the rendered fields themselves stayed put.
  //
  // Whether the live inputs (me/opp) diverge from the baseline — i.e. there's
  // genuinely-unsaved typing worth guarding on exit. Recomputed by the change
  // handlers below as the user types (a clean page, or input matching the
  // saved score, isn't dirty). Compared on digits only: the field now keeps
  // malformed text verbatim (#624), and a stray "." in "11." over a saved "11"
  // must not read as a change and spuriously trip the unsaved-changes blocker
  // (#441) — the baseline is always a clean digit-string, so this matches it.
  const digitsOnly = (value: string) => value.replace(/[^0-9]/g, '')
  const computeDirty = (nextMe: string, nextOpp: string) =>
    digitsOnly(nextMe) !== baseline.me || digitsOnly(nextOpp) !== baseline.opp

  // Take the typed value verbatim — no stripping, no truncating (#624); the
  // shared `isAcceptableScoreInput` only blocks characters that can't begin a
  // score (letters, sign). Keeping the raw text lets a malformed entry stay
  // visible and get flagged inline instead of masquerading as a real score.
  const onMeChange = (value: string) => {
    if (!isAcceptableScoreInput(value)) return
    meField.field.onChange(value)
    setIsDirty(computeDirty(value, opp))
    if (finalizeMutation.error) finalizeMutation.reset()
  }
  const onOppChange = (value: string) => {
    if (!isAcceptableScoreInput(value)) return
    oppField.field.onChange(value)
    setIsDirty(computeDirty(me, value))
    if (finalizeMutation.error) finalizeMutation.reset()
  }

  // The shared single-game verdict via the Zod schema (ADR-0018): 1–2-digit
  // well-formedness, the `illegalScoreReason` table-tennis rule, and the soft
  // "enter both scores" tier. `inputsValid` (a successful parse — both sides
  // filled, well-formed, legal) still gates the finalize prediction and the
  // write; `mapGameScoreValidation` routes the failed-parse issues to ScorePad's
  // per-side red flags / error line, but ONLY after the first submit
  // (`submitted`) — nothing is red while the user first types.
  const parseResult = gameScoreSchema.safeParse({ me, opp })
  const inputsValid = parseResult.success
  // Map the parse result to per-side red flags / error line ONLY after the first
  // submit — before then the fields stay clean even with an illegal or half-typed
  // score, and the mapper's output is discarded anyway; after, `onChange`
  // re-validation clears the red as the user fixes it. A single gate here (rather
  // than one per field) is the whole ADR-0018 "errors-after-first-submit"
  // posture. `inputsValid` above stays UNGATED — it feeds the finalize prediction
  // and the overrun block regardless of submit.
  const ui = submitted ? mapGameScoreValidation(parseResult) : null

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
  const finalize422 = finalizeApiError?.status === 422
  // The cross-game overrun block (a legal score the board can't take) follows
  // the same after-first-submit gate as the Zod errors (ADR-0018 §4).
  const overrunError =
    submitted && overrunAt !== null
      ? `The match is already decided at game ${overrunAt} — clear the games after it before saving this score.`
      : null
  // A finalize error's message line, surfaced regardless of `submitted` (a
  // finalize is inherently post-submit): every finalize error (409/500 included)
  // and a transport-level drop. The negotiation-conflict 409 is shown as the calm
  // redirect notice below instead, so it's excluded here.
  const finalizeErrorText =
    finalizeApiError !== null && !finalizeRedirecting
      ? (finalizeApiError.detail ?? finalizeApiError.message)
      : finalizeNetworkError
        ? "Couldn't post the result — check your connection and try again."
        : null
  // Single `scoreError` slot, in ADR-0018 precedence: local Zod error (after
  // submit) → overrun (after submit) → finalize API error (409/500) → finalize
  // network drop.
  const scoreError = ui?.scoreError ?? overrunError ?? finalizeErrorText
  // The "both scores required" hint is its own, lower-severity line — the schema
  // emits it (post-submit) when either side is empty, but only show it when
  // there's no harder error to surface.
  const showBothRequired = (ui?.showBothRequired ?? false) && scoreError === null
  // Per-side red flags: the mapper already paints only the malformed side, both
  // sides for an illegal score, and the empty side for the soft hint (all gated
  // post-submit — `ui` is null until the first submit); a server 422 drift
  // paints both inputs.
  const meInvalid = (ui?.meInvalid ?? false) || finalize422
  const oppInvalid = (ui?.oppInvalid ?? false) || finalize422

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

  // Async handler used ONLY to reveal validation errors on an invalid submit.
  // React Hook Form's `handleSubmit` returns an async function that `await`s the
  // Zod resolver before deciding — bumping `submitCount` (which flips
  // `submitted` on and turns on live re-validation) either way. Its callback is
  // a no-op: this path never writes and never navigates, so its post-`await`
  // timing is harmless (there is no autofocus to preserve on the error path).
  const revealErrors = form.handleSubmit(() => {})

  // The submit gesture, always live (ADR-0018). The button is never disabled on
  // validity; `onSubmit` is the only gate. It splits by validity SYNCHRONOUSLY:
  // an invalid / board-illegal submit routes through the async `revealErrors`
  // (fine — it only surfaces messages), while a valid, board-legal submit runs
  // the sanctioned write path inline, inside the tap gesture. That synchronous
  // valid path is load-bearing for #567 (see the fire-and-forget tail below):
  // iOS Safari only keeps the soft keyboard open across the next game if the
  // next input's autofocus fires while still inside the tap that triggered it,
  // and RHF's async `handleSubmit` would defer that navigation into a microtask
  // AFTER the tap — dropping the keyboard between games.
  function onSubmit() {
    // A conflict notice is on screen — either kind (#1661 item 6): the user
    // has a real decision to make (Keep saved score / Replace with mine)
    // before this game writes anything at all. Save/Finalize must not fire a
    // write out from under that choice.
    if (conflict || liveConflict) return
    // A Zod-invalid score, or a locally-legal score the board can't take (the
    // cross-game overrun: it would leave the match decided before its last
    // game): surface the messages but write nothing. `revealErrors` bumps
    // `submitCount`, so `submitted` turns on and the inline Zod / `overrunError`
    // lines (both `submitCount`-gated) become visible; live re-validation then
    // clears them as the user fixes the score. No navigation happens here, so
    // routing it through the async `handleSubmit` is fine.
    if (!parseResult.success || overrunAt !== null) {
      void revealErrors()
      return
    }
    // Valid + board-legal: run the sanctioned write path SYNCHRONOUSLY, inside
    // the tap, so the next game's autofocus keeps the mobile keyboard open
    // (#567; see the fire-and-forget tail). This path always either navigates
    // away or surfaces an ungated banner/finalize-error, so it never needs
    // `submitCount` — which is why only the invalid/overrun branch above bumps
    // it, and why the navigating path can't set state after it unmounts.
    //
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
    // the keyboard between games (#567). This is also why `onSubmit` runs this
    // whole path synchronously instead of through RHF's async `handleSubmit`:
    // awaiting the Zod resolver would push this `navigate` into a microtask
    // AFTER the tap, dropping the keyboard the exact same way onSettled did.
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
    if (replacingRef.current) return
    // Drop our rejected scratch save; the inputs fall back to the committed
    // score and the conflict notice clears. `form.reset` to the committed score
    // replaces both fields and clears RHF's dirty flags. Explicitly discard
    // the inherited submit state so this fresh entry starts without errors.
    forgetScoreSaves(queryClient, matchId, gameNumber)
    form.reset(
      {
        me: persistedMe != null ? String(persistedMe) : '',
        opp: persistedOpp != null ? String(persistedOpp) : '',
      },
      { keepSubmitCount: false, keepIsSubmitted: false },
    )
    setIsDirty(false)
  }

  function overwriteWithMyScore() {
    if (replacingRef.current) return
    if (!failedEntry && (!parseResult.success || overrunAt !== null)) {
      void revealErrors()
      return
    }
    // `failedEntry` is the rejected scratch save's own points, for the
    // 409-driven conflict; a live conflict (#1661 item 6) never attempted a
    // save, so there's no rejected scratch — the write is the CURRENTLY
    // TYPED entry instead (`toBody`). Both are the same shape.
    const body = failedEntry ?? (parseResult.success ? toBody() : null)
    if (!body) return
    // Re-fire the save. The cache now holds the committed score (and its newer
    // version — `replaceCommitted` captures it at call time, never
    // the frozen `baseline.version` this component tracks), so the mutation
    // PUTs with that fresh version and overwrites deliberately — no longer a blind
    // last-write-wins, but a choice made against the value we just showed
    // them. This path never navigates, so there is nothing for the
    // unsaved-input blocker to bypass here (ADR 0014, #818): a later
    // user-initiated navigation while still dirty must stay blocked, which the
    // old always-armed latch wrongly waved through.
    //
    // Clear our own `isDirty` on success — without it, a live conflict (which
    // has no mutation-error to fall back to false on its own) would stay
    // "dirty against a stale baseline" forever, and the very next background
    // refetch would re-open the notice we just resolved.
    replacingRef.current = true
    setIsReplacing(true)
    saveMutation.replaceCommitted(body, {
      onSuccess: () => setIsDirty(false),
      onSettled: () => {
        replacingRef.current = false
        setIsReplacing(false)
      },
    })
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
  // fire-and-forget, so we don't want to make the UI feel laggy on those. Also
  // lock during the 409 redirect window so the still-valid submit can't re-fire
  // the same conflict while the match refetches and the early-return navigates.
  const inputsLocked =
    finalizeMutation.isPending || finalizeRedirecting || isReplacing
  const isEdit = mode.kind === 'edit'

  const heading = isEdit
    ? `Edit game ${gameNumber} score.`
    : `Enter game ${gameNumber} score.`
  // A director's proposal always self-finalizes immediately — never left
  // standing for anyone to accept (#1523) — regardless of `affects_rating`,
  // so the acceptance-round-trip copy below is participant-only. Also keeps
  // the screen free of "your opponent" framing on the director's path (AC:
  // no you/them framing).
  const requiresAcceptance = data.affects_rating && !isDirectorView
  const subtitle = wouldFinalize
    ? requiresAcceptance
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
      ? requiresAcceptance
        ? 'Posting result…'
        : 'Finalizing…'
      : requiresAcceptance
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
          {/* No "0–9" here: games are to 11, and naming the digit keys reads as
              a cap on the score itself (#896). Kept short enough to stay on one
              line at 1024px, where the sidebar squeezes this header. */}
          <div className="hint">
            Use number keys &nbsp;·&nbsp; <kbd>Enter</kbd> to save
          </div>
        </div>

        <SaveBanner
          matchId={matchId}
          activeGameNumber={gameNumber}
          proposeMutation={finalizeMutation}
        />

        {(conflict || liveConflict) && (
          <ScoreConflictNotice
            meName={meName}
            oppName={oppName}
            committedMe={persistedMe ?? null}
            committedOpp={persistedOpp ?? null}
            yourMe={noticeYourMe}
            yourOpp={noticeYourOpp}
            onKeepCommitted={keepCommittedScore}
            onUseMine={overwriteWithMyScore}
            isPending={isReplacing}
          />
        )}

        {finalizeRedirecting && (
          // Calm "the app talking back" notice (design-system Alert, default
          // variant — not the red error line) for the transient window between a
          // propose 409 and the refetch-driven redirect to match detail.
          <Alert className="mb-3">
            <Loader2 className="animate-spin" aria-hidden />
            <AlertTitle>This match already has a posted result</AlertTitle>
            <AlertDescription>Taking you there…</AlertDescription>
          </Alert>
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
          // The single error slot, already resolved in ADR-0018 precedence: the
          // local Zod error (after submit) → the cross-game overrun block (after
          // submit) → a finalize API rejection (409/500) → a transport-level
          // drop's connection copy. The connection copy is last because an
          // `ApiError` (a real server verdict) is always the more specific thing
          // to say; a bare transport failure is the fallback when the POST never
          // reached the server at all (#868).
          scoreError={scoreError}
          showBothRequired={showBothRequired}
          inputsLocked={inputsLocked}
          subtitle={subtitle}
          submitLabel={submitLabel}
          // Never gated on validity (ADR-0018): the button is always live, and
          // `handleSubmit` (in `submit`) is the only gate. It's disabled only by
          // genuine in-flight locks via `inputsLocked` (finalize pending /
          // 409-redirect window), handled inside ScorePad.
          canSubmit
          onSubmit={onSubmit}
          // The scratchpad is contiguous (#1661 item 5): Clear is offered only
          // for the HIGHEST saved game — clearing an earlier one would leave a
          // gap under a later saved game, the same 422 the write path itself
          // guards. An earlier game stays editable via the inputs above; it
          // just loses its own Clear affordance.
          onClear={
            isEdit && gameNumber === highestSavedGame ? onClear : undefined
          }
          clearDisabled={deleteMutation.isPending}
        />

        {bestOf > 1 && (
          <Scoreline
            data={data}
            activeGameNumber={gameNumber}
            decider={decider}
            matchId={matchId}
            mySideNumber={mySideNumber}
            highestSavedGame={highestSavedGame}
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
  isPending,
}: {
  meName: string
  oppName: string
  committedMe: number | null
  committedOpp: number | null
  yourMe: number | null
  yourOpp: number | null
  onKeepCommitted: () => void
  onUseMine: () => void
  isPending: boolean
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
            disabled={isPending}
          >
            Keep saved score
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-[color:var(--loss)]/50 text-[color:var(--loss)] hover:bg-[color:var(--loss)]/10 hover:text-[color:var(--loss)]"
            onClick={onUseMine}
            disabled={isPending}
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
  highestSavedGame,
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
  /** The highest-numbered committed game (computed by the parent) — the only
   * one whose ✕ is offered (#1661 item 5). */
  highestSavedGame: number
  onClearCell: (gameNumber: number) => void
  clearDisabled: boolean
}) {
  // The first UNCOMMITTED game, overall — the scratchpad's one contiguous
  // frontier (#1661 item 5). Every other blank cell renders inert: tapping it
  // would open a create screen the write path would 422 on ("Save game K
  // before game N."), so it isn't offered as a link at all.
  const nextUnsaved = (() => {
    for (let n = 1; n <= data.best_of; n += 1) {
      if (!data.games.find((g) => g.game_number === n)?.score) return n
    }
    return null
  })()
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
              nextUnsaved={nextUnsaved}
              mySideNumber={mySideNumber}
              canClear={n === highestSavedGame}
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
  nextUnsaved,
  mySideNumber,
  canClear,
  clearDisabled,
  onClear,
}: {
  n: number
  matchId: string
  score: PersistedScore | null
  isActive: boolean
  playable: boolean
  /** The scratchpad's one open frontier — the first uncommitted game overall
   * (computed by the parent), or `null` when every game is committed. Only
   * this game's blank cell is a link (#1661 item 5); every other blank cell
   * renders inert, since tapping it would open an entry screen the write path
   * would refuse. */
  nextUnsaved: number | null
  mySideNumber: 1 | 2
  /** Whether THIS cell may offer its ✕ — true only for the highest committed
   * game (#1661 item 5); an earlier saved game stays editable but not
   * clearable, mirroring the write path's own guard. */
  canClear: boolean
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
    score && !saving && !failed && !showResolved && canClear ? (
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

  // The scratchpad is contiguous (#1661 item 5): a blank cell that is NOT the
  // next unsaved game is not a navigation target at all — the entry screen it
  // would open is exactly the boundary refusal ("Save game K before game N."),
  // so offering the link would be a dead end dressed as a normal one. Only a
  // genuinely blank cell is affected — a failed/saving scratch keeps its own
  // link so it stays retryable regardless of position.
  if (!score && !failed && n !== nextUnsaved) {
    return (
      <div className={cls} aria-label={ariaLabel}>
        {inner}
      </div>
    )
  }

  return (
    <Link {...target} className={cls} aria-label={ariaLabel}>
      {inner}
    </Link>
  )
}
