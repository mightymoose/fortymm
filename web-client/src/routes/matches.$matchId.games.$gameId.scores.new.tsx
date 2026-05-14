import { useEffect, useMemo, useRef, useState } from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'

export const Route = createFileRoute(
  '/matches/$matchId/games/$gameId/scores/new',
)({
  component: ScoreEntryRoute,
})

/**
 * Match context is mocked here. The matches API is not wired up yet, so this
 * mirrors the static stubs used by the dashboard and admin routes — replace
 * MATCH with loader-fed data once the endpoint exists. Saving a game then
 * advances through the match instead of persisting.
 */
const ME = { name: 'You', initials: 'YZ' } as const

type LoggedGame = { me: number; opp: number }
type MatchGame = LoggedGame | null

const MATCH = {
  bestOf: 5,
  rated: true,
  opponent: { name: 'Nguyen, T.', initials: 'NT', rating: 2145, isGuest: false },
  // Index = game number - 1. `null` marks a game that has not been played yet.
  games: [{ me: 11, opp: 8 }, { me: 9, opp: 11 }, null, null, null] as MatchGame[],
}

function ScoreEntryRoute() {
  const { matchId, gameId } = Route.useParams()
  // Remount the entry form whenever the game in the URL changes so the score
  // fields reset cleanly to that game's stored value.
  return <ScoreEntry key={gameId} matchId={matchId} gameId={gameId} />
}

function ScoreEntry({ matchId, gameId }: { matchId: string; gameId: string }) {
  const navigate = useNavigate()

  const { bestOf, rated, opponent, games } = MATCH
  const gamesToWin = Math.ceil(bestOf / 2)
  const isGuest = opponent.isGuest

  // The game this route targets (1-based), clamped to the match length.
  const gameNumber = useMemo(() => {
    const parsed = Number.parseInt(gameId, 10)
    if (!Number.isFinite(parsed)) return 1
    return Math.min(Math.max(parsed, 1), bestOf)
  }, [gameId, bestOf])
  const activeIdx = gameNumber - 1

  const stored = games[activeIdx]
  const [me, setMe] = useState(() => (stored ? String(stored.me) : ''))
  const [opp, setOpp] = useState(() => (stored ? String(stored.opp) : ''))
  const meRef = useRef<HTMLInputElement>(null)
  const oppRef = useRef<HTMLInputElement>(null)

  // Game tally so far, counted from every *other* logged game in the match.
  const meWins = games.filter(
    (g, i) => i !== activeIdx && g != null && g.me > g.opp,
  ).length
  const oppWins = games.filter(
    (g, i) => i !== activeIdx && g != null && g.opp > g.me,
  ).length
  const matchComplete = meWins >= gamesToWin || oppWins >= gamesToWin
  const winner = meWins > oppWins ? 'me' : oppWins > meWins ? 'opp' : null

  const sanitize = (value: string) => value.replace(/[^0-9]/g, '').slice(0, 2)
  const canSave =
    me !== '' && opp !== '' && Number(me) !== Number(opp) && !matchComplete

  function goToGame(number: number) {
    navigate({
      to: '/matches/$matchId/games/$gameId/scores/new',
      params: { matchId, gameId: String(number) },
    })
  }

  function saveGame() {
    if (!canSave) return
    // No persistence layer yet — advance to the next game's entry screen, or
    // hand off to the (future) match summary once the match is decided.
    const meScore = Number(me)
    const oppScore = Number(opp)
    const nextMeWins = meWins + (meScore > oppScore ? 1 : 0)
    const nextOppWins = oppWins + (oppScore > meScore ? 1 : 0)
    const decided = nextMeWins >= gamesToWin || nextOppWins >= gamesToWin
    if (!decided && gameNumber < bestOf) {
      goToGame(gameNumber + 1)
    } else {
      navigate({ to: '/dashboard' })
    }
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

  // Focus the first score field on arrival.
  useEffect(() => {
    const timer = setTimeout(() => meRef.current?.focus(), 60)
    return () => clearTimeout(timer)
  }, [])

  const pad = (n: number) => String(n).padStart(2, '0')
  const gameLabel = `GAME ${pad(gameNumber)} OF ${pad(bestOf)}`
  const oppName = opponent.name

  return (
    <div className="fortymm-theme dark score-entry-screen">
      <div className="live-bar">
        <button
          type="button"
          className="back"
          onClick={() => navigate({ to: '/dashboard' })}
        >
          ← Back to match
        </button>
        <span className="tag">
          <span className="dot" /> {gameLabel}
        </span>
        <span className="meta">
          {rated && !isGuest ? 'RATED' : 'UNRATED'} · BEST OF {bestOf} · FIRST TO{' '}
          {gamesToWin}
        </span>
      </div>

      <div className="entry-wrap">
        <div className="entry-head">
          <h2>
            {matchComplete
              ? 'Match complete.'
              : `Enter game ${gameNumber} score.`}
          </h2>
          {!matchComplete && (
            <div className="hint">
              <kbd>0</kbd>–<kbd>9</kbd> score &nbsp;·&nbsp; <kbd>Enter</kbd> next
              / save game
            </div>
          )}
        </div>

        {/* Big side-by-side entry for the current game */}
        <div className={`single-entry${matchComplete ? ' complete' : ''}`}>
          <div className="se-side me">
            <div className="se-head">
              <div className="av">{ME.initials}</div>
              <div>
                <div className="nm">{ME.name}</div>
                <div className="rt">
                  Games won · <b>{meWins}</b>
                </div>
              </div>
            </div>
            <input
              ref={meRef}
              className="big-input"
              type="text"
              inputMode="numeric"
              aria-label={`${ME.name} score`}
              placeholder="0"
              value={me}
              disabled={matchComplete}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setMe(sanitize(e.target.value))}
              onKeyDown={(e) => handleKey(e, 'me')}
            />
          </div>

          <div className="se-mid">
            <div className="se-vs">VS</div>
            <div className="se-games">
              {meWins} – {oppWins}
            </div>
          </div>

          <div className={`se-side opp${isGuest ? ' guest' : ''}`}>
            <div className="se-head right">
              <div>
                <div className="nm">{oppName}</div>
                <div className="rt">
                  Games won · <b>{oppWins}</b>
                </div>
              </div>
              <div className="av">{opponent.initials}</div>
            </div>
            <input
              ref={oppRef}
              className="big-input"
              type="text"
              inputMode="numeric"
              aria-label={`${oppName} score`}
              placeholder="0"
              value={opp}
              disabled={matchComplete}
              onFocus={(e) => e.target.select()}
              onChange={(e) => setOpp(sanitize(e.target.value))}
              onKeyDown={(e) => handleKey(e, 'opp')}
            />
          </div>
        </div>

        {/* Action row */}
        <div className="single-actions">
          {matchComplete ? (
            <div className="result-line">
              <span className="trophy">▲</span>
              <span>
                {winner === 'me'
                  ? `${ME.name} won the match`
                  : `${oppName} won the match`}
              </span>
              <span className="dot-sep">·</span>
              <span className="final">
                FINAL {meWins}–{oppWins}
              </span>
            </div>
          ) : (
            <div className="result-line subtle">
              {gameNumber < bestOf
                ? `Save this game to continue to game ${gameNumber + 1}.`
                : 'Final game. Save to finish the match.'}
            </div>
          )}
          <div className="action-btns">
            {!matchComplete && gameNumber > 1 && (
              <button
                type="button"
                className="btn ghost"
                onClick={() => goToGame(gameNumber - 1)}
              >
                ← Edit game {gameNumber - 1}
              </button>
            )}
            {!matchComplete && (
              <button
                type="button"
                className="btn primary"
                disabled={!canSave}
                onClick={saveGame}
              >
                {gameNumber < bestOf
                  ? 'Save game & next →'
                  : 'Save final game →'}
              </button>
            )}
            {matchComplete && (
              <button
                type="button"
                className="btn primary"
                onClick={() => navigate({ to: '/dashboard' })}
              >
                Back to match
              </button>
            )}
          </div>
        </div>

        {/* Scoreline strip — all games in the match */}
        <div className="scoreline">
          <div className="sl-label">SCORELINE</div>
          <div className="sl-cells">
            {games.map((g, i) => {
              const isActive = i === activeIdx
              const logged = !isActive && g != null
              const meVal = isActive ? me : g ? String(g.me) : ''
              const oppVal = isActive ? opp : g ? String(g.opp) : ''
              const meWon = !isActive && g != null && g.me > g.opp
              const oppWon = !isActive && g != null && g.opp > g.me
              return (
                <button
                  type="button"
                  key={i}
                  className={`sl-cell ${logged ? 'done' : 'pending'}${
                    isActive ? ' active' : ''
                  }`}
                  aria-current={isActive ? 'step' : undefined}
                  onClick={() => {
                    if (!isActive) goToGame(i + 1)
                  }}
                >
                  <div className="sl-n">G{i + 1}</div>
                  <div className="sl-scores">
                    <span className={`s${meWon ? ' w' : ''}`}>
                      {meVal || '—'}
                    </span>
                    <span className="dash">–</span>
                    <span className={`s${oppWon ? ' w' : ''}`}>
                      {oppVal || '—'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
