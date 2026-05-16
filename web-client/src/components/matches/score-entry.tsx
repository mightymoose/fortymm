import { useRef, useState } from 'react'
import { Link, Navigate, useNavigate } from '@tanstack/react-router'
import type { UseMutationResult } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import {
  scoringEditRoute,
  scoringNewRoute,
  useMatch,
  type MatchDetails,
  type MatchGameScoreWrite,
} from '@/api/matches'
import { cn, initialsOf } from '@/lib/utils'

export type ScoreMutation = UseMutationResult<
  MatchDetails,
  Error,
  MatchGameScoreWrite,
  unknown
>

export type ScoreEntryMode =
  | { kind: 'create' }
  | { kind: 'edit'; scoreId: string }

export function ScoreEntry({
  matchId,
  gameId,
  mode,
  mutation,
}: {
  matchId: string
  gameId: string
  mode: ScoreEntryMode
  mutation: ScoreMutation
}) {
  // Remount whenever the URL targets a different game so the input state and
  // mutation error don't leak across games.
  return (
    <ScoreEntryInner
      key={`${gameId}:${mode.kind === 'edit' ? mode.scoreId : 'new'}`}
      matchId={matchId}
      gameId={gameId}
      mode={mode}
      mutation={mutation}
    />
  )
}

function ScoreEntryInner({
  matchId,
  gameId,
  mode,
  mutation,
}: {
  matchId: string
  gameId: string
  mode: ScoreEntryMode
  mutation: ScoreMutation
}) {
  const navigate = useNavigate()
  const { data, isLoading } = useMatch(matchId)

  // `null` means "user hasn't typed anything yet" — render falls through to
  // the persisted score in edit mode. This avoids a state-syncing effect
  // (cascading-render anti-pattern) when `data` arrives after first render.
  const [meTyped, setMeTyped] = useState<string | null>(null)
  const [oppTyped, setOppTyped] = useState<string | null>(null)
  const meRef = useRef<HTMLInputElement>(null)
  const oppRef = useRef<HTMLInputElement>(null)

  if (isLoading || !data) {
    return (
      <div
        className="fortymm-theme dark score-entry-screen"
        aria-busy="true"
        data-testid="score-entry-loading"
      />
    )
  }

  if (!data.opponent_side) {
    return <Navigate to="/matches/$matchId" params={{ matchId }} />
  }

  const game = data.games.find((g) => g.id === gameId)
  if (!game) {
    return <Navigate to="/matches/$matchId" params={{ matchId }} />
  }

  const mySideNumber = data.my_side.side_number === 2 ? 2 : 1
  const oppName = data.opponent_side.players[0]?.username ?? 'Opponent'
  const meName = data.my_side.players[0]?.username ?? 'You'
  const meInitials = initialsOf(meName)
  const oppInitials = initialsOf(oppName)

  const bestOf = data.best_of
  const gamesToWin = data.games_to_win
  const gameNumber = game.game_number

  const meWins = data.my_side.games_won
  const oppWins = data.opponent_side.games_won

  const persistedScore = mode.kind === 'edit' ? game.score : null
  const me =
    meTyped ?? (persistedScore ? String(persistedScore.my_points) : '')
  const opp =
    oppTyped ?? (persistedScore ? String(persistedScore.opponent_points) : '')

  const sanitize = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 2)
  const onMeChange = (value: string) => {
    setMeTyped(sanitize(value))
    if (mutation.error) mutation.reset()
  }
  const onOppChange = (value: string) => {
    setOppTyped(sanitize(value))
    if (mutation.error) mutation.reset()
  }

  const inputsValid =
    me !== '' && opp !== '' && Number(me) !== Number(opp)
  const apiError = mutation.error instanceof ApiError ? mutation.error : null

  // 409 from the API means the game is either already scored (create) or the
  // match isn't scorable. Both swap out the regular controls for a back-link.
  const lockedReason =
    apiError && apiError.status === 409
      ? apiError.detail ?? apiError.message
      : null

  function toBody(mine: number, opponent: number): MatchGameScoreWrite {
    return mySideNumber === 1
      ? { side_1_points: mine, side_2_points: opponent }
      : { side_1_points: opponent, side_2_points: mine }
  }

  function saveGame() {
    if (!inputsValid) return
    mutation.mutate(toBody(Number(me), Number(opp)), {
      onSuccess: (response) => {
        if (response.current_game) {
          navigate(scoringNewRoute(matchId, response.current_game.id))
        } else {
          navigate({ to: '/matches/$matchId', params: { matchId } })
        }
      },
    })
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>, side: 'me' | 'opp') {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (side === 'me' && me !== '') {
        oppRef.current?.focus()
        oppRef.current?.select()
      } else if (side === 'opp') {
        saveGame()
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

  const pad = (n: number) => String(n).padStart(2, '0')
  const gameLabel = `GAME ${pad(gameNumber)} OF ${pad(bestOf)}`
  const inputsLocked = mutation.isPending || lockedReason !== null
  const isEdit = mode.kind === 'edit'

  const heading = isEdit
    ? `Edit game ${gameNumber} score.`
    : `Enter game ${gameNumber} score.`
  const subtitle = isEdit
    ? 'Save updates the score for this game.'
    : gameNumber < bestOf
      ? `Save this game to continue to game ${gameNumber + 1}.`
      : 'Final game. Save to finish the match.'
  const saveLabel = mutation.isPending
    ? 'Saving…'
    : isEdit
      ? 'Save changes →'
      : gameNumber < bestOf
        ? 'Save game & next →'
        : 'Save final game →'

  // The "already scored" 409 only happens on the create route. The existing
  // score id is in the cached payload, so we can offer a direct switch to its
  // edit route.
  const editLink =
    mode.kind === 'create' &&
    apiError?.status === 409 &&
    apiError.detail?.includes('already been scored') &&
    game.score
      ? scoringEditRoute(matchId, gameId, game.score.id)
      : null

  return (
    <div className="fortymm-theme dark score-entry-screen">
      <div className="live-bar">
        <Link
          to="/matches/$matchId"
          params={{ matchId }}
          className="back"
        >
          ← Back to match
        </Link>
        <span className="tag">
          <span className="dot" /> {gameLabel}
        </span>
        <span className="meta">
          {data.affects_rating ? 'RATED' : 'UNRATED'} · BEST OF {bestOf} ·
          FIRST TO {gamesToWin}
        </span>
      </div>

      <div className="entry-wrap">
        <div className="entry-head">
          <h2>{heading}</h2>
          {!lockedReason && (
            <div className="hint">
              <kbd>0</kbd>–<kbd>9</kbd> score &nbsp;·&nbsp; <kbd>Enter</kbd> next
              / save game
            </div>
          )}
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
            invalid={apiError !== null && apiError.status === 422}
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
            initials={oppInitials}
            wins={oppWins}
            value={opp}
            inputRef={oppRef}
            disabled={inputsLocked}
            invalid={apiError !== null && apiError.status === 422}
            onChange={onOppChange}
            onKeyDown={(e) => handleKey(e, 'opp')}
          />
        </div>

        {apiError && apiError.status === 422 && (
          <p
            role="alert"
            className="mt-1.5 text-xs text-[color:var(--loss)]"
          >
            {apiError.detail ?? apiError.message}
          </p>
        )}

        <div className="single-actions">
          {lockedReason ? (
            <>
              <div className="result-line subtle" role="alert">
                {lockedReason}
              </div>
              <div className="action-btns">
                {editLink && (
                  <Link {...editLink} className="btn ghost">
                    Edit existing score
                  </Link>
                )}
                <Link
                  to="/matches/$matchId"
                  params={{ matchId }}
                  className="btn primary"
                >
                  Back to match
                </Link>
              </div>
            </>
          ) : (
            <>
              <div className="result-line subtle">{subtitle}</div>
              <div className="action-btns">
                <button
                  type="button"
                  className="btn primary"
                  disabled={!inputsValid || mutation.isPending}
                  onClick={saveGame}
                >
                  {saveLabel}
                </button>
              </div>
            </>
          )}
        </div>

        <Scoreline
          data={data}
          activeGameId={gameId}
          matchId={matchId}
        />
      </div>
    </div>
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
  initials: string
  wins: number
  value: string
  inputRef: React.RefObject<HTMLInputElement | null>
  autoFocus?: boolean
  disabled: boolean
  invalid: boolean
  onChange: (value: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
}) {
  const avatar = <div className="av">{initials}</div>
  const identity = (
    <div>
      <div className="nm">{name}</div>
      <div className="rt">
        Games won · <b>{wins}</b>
      </div>
    </div>
  )

  return (
    <div className={cn('se-side', side)}>
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
  activeGameId,
  matchId,
}: {
  data: MatchDetails
  activeGameId: string
  matchId: string
}) {
  const slots: Array<MatchDetails['games'][number] | null> = []
  for (let n = 1; n <= data.best_of; n += 1) {
    slots.push(data.games.find((g) => g.game_number === n) ?? null)
  }
  return (
    <div className="scoreline">
      <div className="sl-label">SCORELINE</div>
      <div className="sl-cells">
        {slots.map((g, i) => {
          if (!g) {
            return (
              <div key={i} className={cn('sl-cell', 'pending')}>
                <div className="sl-n">G{i + 1}</div>
                <div className="sl-scores">
                  <span className="s">—</span>
                  <span className="dash">–</span>
                  <span className="s">—</span>
                </div>
              </div>
            )
          }
          const isActive = g.id === activeGameId
          const score = g.score
          const cls = cn(
            'sl-cell',
            score ? 'done' : 'pending',
            isActive && 'active',
          )
          const inner = (
            <>
              <div className="sl-n">G{g.game_number}</div>
              <div className="sl-scores">
                <span className={cn('s', score?.is_my_win === true && 'w')}>
                  {score?.my_points ?? '—'}
                </span>
                <span className="dash">–</span>
                <span className={cn('s', score?.is_my_win === false && 'w')}>
                  {score?.opponent_points ?? '—'}
                </span>
              </div>
            </>
          )
          if (isActive) {
            return (
              <div key={g.id} className={cls} aria-current="step">
                {inner}
              </div>
            )
          }
          if (score) {
            return (
              <Link
                key={g.id}
                {...scoringEditRoute(matchId, g.id, score.id)}
                className={cls}
              >
                {inner}
              </Link>
            )
          }
          return (
            <div key={g.id} className={cls}>
              {inner}
            </div>
          )
        })}
      </div>
    </div>
  )
}

