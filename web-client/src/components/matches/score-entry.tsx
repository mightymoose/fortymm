import { useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from '@tanstack/react-router'
import { User as UserIcon, X as XIcon } from 'lucide-react'
import { ApiError } from '@/api/client'
import {
  matchDetailRoute,
  scoringEditRoute,
  scoringNewRoute,
  useCreateScore,
  useDeleteScore,
  useDeleteScoreForMatch,
  useFinalizeMatch,
  useMatch,
  useUpdateScore,
  type MatchDetails,
  type MatchGameScoreWrite,
  type MatchResultsGameWrite,
} from '@/api/matches'
import { AppShell } from '@/components/app-shell'
import { cn, initialsOf } from '@/lib/utils'
import { decidedSide, illegalScoreReason } from '@/lib/scoring'

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
  const { data, isLoading } = useMatch(matchId)
  const createMutation = useCreateScore(matchId, gameNumber)
  const updateMutation = useUpdateScore(matchId, gameNumber)
  const deleteMutation = useDeleteScore(matchId, gameNumber)
  const cellDeleteMutation = useDeleteScoreForMatch(matchId)
  const finalizeMutation = useFinalizeMatch(matchId)

  // `null` means "user hasn't typed anything yet" — we fall through to the
  // persisted score in edit mode. Avoids a state-syncing effect when `data`
  // arrives after first render.
  const [meTyped, setMeTyped] = useState<string | null>(null)
  const [oppTyped, setOppTyped] = useState<string | null>(null)
  const meRef = useRef<HTMLInputElement>(null)
  const oppRef = useRef<HTMLInputElement>(null)

  if (isLoading || !data) {
    return (
      <AppShell>
        <div aria-busy="true" data-testid="score-entry-loading" />
      </AppShell>
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
  if (mode.kind === 'create' && persistedScore) {
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
  const me = meTyped ?? (persistedMe !== null ? String(persistedMe) : '')
  const opp = oppTyped ?? (persistedOpp !== null ? String(persistedOpp) : '')

  const sanitize = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 2)
  const onMeChange = (value: string) => {
    setMeTyped(sanitize(value))
    if (finalizeMutation.error) finalizeMutation.reset()
  }
  const onOppChange = (value: string) => {
    setOppTyped(sanitize(value))
    if (finalizeMutation.error) finalizeMutation.reset()
  }

  const bothFilled = me !== '' && opp !== ''
  const localScoreError = bothFilled
    ? illegalScoreReason(Number(me), Number(opp))
    : null
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
  // per-game mutations (create / update / delete) self-heal at finalize, so
  // their errors are intentionally hidden.
  const finalizeApiError =
    finalizeMutation.error instanceof ApiError ? finalizeMutation.error : null
  const showScoreError =
    localScoreError !== null ||
    (finalizeApiError !== null && finalizeApiError.status === 422)

  function predictNextScoringRoute() {
    if (!data) return matchDetailRoute(matchId)
    const nowScored = new Set<number>([
      ...data.games.filter((g) => g.score).map((g) => g.game_number),
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
    if (wouldFinalize) {
      finalizeMutation.mutate(
        { games: hypotheticalGames },
        { onSuccess: () => navigate(matchDetailRoute(matchId)) },
      )
      return
    }
    const next = predictNextScoringRoute()
    const args = toBody()
    // Fire-and-forget — we don't surface per-game errors, and we navigate as
    // soon as the request settles either way. Even on failure, the canonical
    // POST /results will reconcile the score later.
    const settle = { onSettled: () => navigate(next) }
    if (mode.kind === 'edit') {
      updateMutation.mutate(args, settle)
    } else {
      createMutation.mutate(args, settle)
    }
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

  function onClear() {
    if (mode.kind !== 'edit') return
    deleteMutation.mutate(undefined, {
      // After clearing, land back on this game's create route so the user
      // can re-enter — same page, just with empty inputs and create-mode
      // semantics. The remount's autoFocus puts focus on the me-input,
      // which is the first empty input.
      onSettled: () => navigate(scoringNewRoute(matchId, gameNumber)),
    })
  }

  // Per-cell ✕ — clears the score for any logged game from the scoreline
  // strip. Fire-and-forget like the per-game writes; we just refocus the
  // first empty input on the current page so the user can keep typing.
  function onClearCell(n: number) {
    cellDeleteMutation.mutate(n)
    focusFirstEmpty()
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
    ? 'This score finishes the match — submitting posts the result for your opponent to confirm.'
    : isEdit
      ? 'Save updates the score for this game.'
      : gameNumber < bestOf
        ? `Save this game to continue to game ${gameNumber + 1}.`
        : 'Final game. Save to post the result.'
  const submitLabel = wouldFinalize
    ? finalizeMutation.isPending
      ? 'Posting result…'
      : 'Post result'
    : isEdit
      ? 'Save changes →'
      : gameNumber < bestOf
        ? 'Save game & next →'
        : 'Save final game →'

  return (
    <AppShell>
      <div className="entry-wrap">
        <div className="entry-head">
          <h2>{heading}</h2>
          <div className="hint">
            <kbd>0</kbd>–<kbd>9</kbd> score &nbsp;·&nbsp; <kbd>Enter</kbd> next
            / save game
          </div>
        </div>

        <div className="single-entry">
          <ScoreSide
            side="me"
            name={meName}
            initials={meInitials}
            wins={meWins}
            value={me}
            inputRef={meRef}
            autoFocus
            disabled={inputsLocked}
            invalid={showScoreError}
            onChange={onMeChange}
            onKeyDown={(e) => handleKey(e, 'me')}
          />

          <div className="se-mid">
            <div className="se-vs">VS</div>
            <div className="se-games">
              {meWins} – {oppWins}
            </div>
          </div>

          <ScoreSide
            side="opp"
            name={oppName}
            initials={oppHasPlayer ? initialsOf(oppName) : null}
            wins={oppWins}
            value={opp}
            inputRef={oppRef}
            disabled={inputsLocked}
            invalid={showScoreError}
            onChange={onOppChange}
            onKeyDown={(e) => handleKey(e, 'opp')}
          />
        </div>

        {showScoreError && (
          <p
            role="alert"
            className="mt-1.5 text-xs text-[color:var(--loss)]"
          >
            {localScoreError ??
              finalizeApiError?.detail ??
              finalizeApiError?.message}
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
    </AppShell>
  )
}

function ScoreSide({
  side,
  name,
  initials,
  wins,
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
  wins: number
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
    <div>
      <div className="nm">{name}</div>
      <div className="rt">
        Games won · <b>{wins}</b>
      </div>
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
  // Every cell links to its own scoring route — scored games go to edit,
  // un-scored games go to /scores/new. Lets the user pick games in any
  // order from the scoreline directly. Logged cells also carry a ✕ button
  // (desktop hover; hidden on touch) that clears that game in place.
  // `--sl-cell-count` drives the mobile grid template so the cells fit
  // exactly the best-of width (the desktop layout flex-wraps regardless).
  return (
    <div className="scoreline">
      <div className="sl-label">SCORELINE</div>
      <div
        className="sl-cells"
        style={{ '--sl-cell-count': data.best_of } as React.CSSProperties}
      >
        {Array.from({ length: data.best_of }, (_, i) => i + 1).map((n) => {
          const g = data.games.find((x) => x.game_number === n) ?? null
          const score = g?.score ?? null
          const isActive = n === activeGameNumber
          const cls = cn(
            'sl-cell',
            score ? 'done' : 'pending',
            isActive && 'active',
          )
          const myPoints = score
            ? mySideNumber === 1
              ? score.side_1_points
              : score.side_2_points
            : null
          const oppPoints = score
            ? mySideNumber === 1
              ? score.side_2_points
              : score.side_1_points
            : null
          const isMyWin = score
            ? score.winner_side_number === mySideNumber
            : null
          const clearBtn = score ? (
            <button
              type="button"
              className="sl-clear"
              aria-label={`Clear game ${n}`}
              title={`Clear game ${n}`}
              disabled={clearDisabled}
              onClick={(e) => {
                // Stop the surrounding Link from navigating to /edit on the
                // cell we just cleared. preventDefault is what blocks
                // TanStack Router's nav (it checks defaultPrevented before
                // dispatching) — stopPropagation is belt-and-suspenders.
                e.preventDefault()
                e.stopPropagation()
                onClearCell(n)
              }}
            >
              <XIcon size={14} strokeWidth={2.5} aria-hidden />
            </button>
          ) : null
          const inner = (
            <>
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
              {clearBtn}
            </>
          )
          if (isActive) {
            return (
              <div key={n} className={cls} aria-current="step">
                {inner}
              </div>
            )
          }
          const target = score
            ? scoringEditRoute(matchId, n)
            : scoringNewRoute(matchId, n)
          return (
            <Link key={n} {...target} className={cls}>
              {inner}
            </Link>
          )
        })}
      </div>
    </div>
  )
}
