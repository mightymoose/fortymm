import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useRouter } from '@tanstack/react-router'
import {
  Check,
  Clock,
  Copy,
  Download,
  Link2,
  Send,
  Share2,
  X,
} from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { cn, initialsOf } from '@/lib/utils'
import { formatRatingDelta } from '@/lib/rating'
import { scoringEditRoute, scoringNewRoute, useMatch } from '@/api/matches'
import type { components } from '@/api/schema'
import { ApiError } from '@/api/client'

type MatchDetails = components['schemas']['MatchDetails']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type RatingChange = components['schemas']['RatingChange']

type HeroState = 'live' | 'final' | 'upcoming'

type SideView = {
  username: string
  initials: string
  gamesWon: number
  won: boolean | null
  ratingChange: RatingChange | null
}

type GameView = {
  id: string
  gameNumber: number
  // `null` for an un-scored trailing game.
  score: { mine: number; opponent: number; isMyWin: boolean } | null
  // The full score record for an edit-link affordance. Null when the game
  // hasn't been scored yet.
  scoreId: string | null
}

type MatchView = {
  state: HeroState
  statusLabel: string
  bestOf: number
  gamesToWin: number
  rated: boolean
  mySide: SideView
  opponentSide: SideView | null
  games: GameView[]
  currentGameNumber: number | null
  canScore: boolean
  scoreCta: { matchId: string; gameId: string } | null
}

function projectSide(side: MatchDetailsSide, fallbackLabel: string): SideView {
  const username = side.players[0]?.username ?? fallbackLabel
  return {
    username,
    initials: initialsOf(username),
    gamesWon: side.games_won,
    won: side.won,
    ratingChange: side.rating_change ?? null,
  }
}

function projectGame(game: MatchDetailsGame): GameView {
  const score = game.score
  if (!score) return { id: game.id, gameNumber: game.game_number, score: null, scoreId: null }
  // `my_points` / `opponent_points` are already current-user-relative — the
  // API swaps them based on `my_side.side_number` server-side.
  return {
    id: game.id,
    gameNumber: game.game_number,
    score: {
      mine: score.my_points,
      opponent: score.opponent_points,
      isMyWin: score.is_my_win,
    },
    scoreId: score.id,
  }
}

function projectMatchView(data: MatchDetails, matchId: string): MatchView {
  const state: HeroState =
    data.status === 'in_progress'
      ? 'live'
      : data.status === 'completed'
        ? 'final'
        : 'upcoming'
  const mySide = projectSide(data.my_side, 'You')
  const opponentSide = data.opponent_side
    ? projectSide(data.opponent_side, 'Opponent')
    : null
  const games = data.games
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map(projectGame)
  const scoreCta =
    data.can_score && data.current_game
      ? { matchId, gameId: data.current_game.id }
      : null
  return {
    state,
    statusLabel: data.status_label,
    bestOf: data.best_of,
    gamesToWin: data.games_to_win,
    rated: data.affects_rating,
    mySide,
    opponentSide,
    games,
    currentGameNumber: data.current_game?.game_number ?? null,
    canScore: data.can_score,
    scoreCta,
  }
}

export function MatchDetailsView({ matchId }: { matchId: string }) {
  const { data, isLoading } = useMatch(matchId)

  if (isLoading || !data) {
    return (
      <AppShell>
        <MatchDetailsSkeleton />
      </AppShell>
    )
  }

  if (!data.opponent_side) {
    // Solo matches aren't viewable on this page yet — the surface assumes
    // two sides.
    return <Navigate to="/matches" />
  }

  const view = projectMatchView(data, matchId)
  return (
    <AppShell>
      <MatchDetailsPage view={view} matchId={matchId} />
    </AppShell>
  )
}

export function MatchDetailsError({
  error,
  reset,
}: {
  error: Error
  reset: () => void
}) {
  const router = useRouter()
  const status = error instanceof ApiError ? error.status : 0
  const message =
    status === 404
      ? "We couldn't find that match."
      : error.message || "Something went wrong loading this match."
  return (
    <AppShell>
      <div role="alert" className="md-error-state">
        <div className="md-error-state__title">{message}</div>
        <button
          type="button"
          className="md-btn md-btn--secondary"
          onClick={() => {
            reset()
            router.invalidate()
          }}
        >
          Try again
        </button>
      </div>
    </AppShell>
  )
}

function MatchDetailsSkeleton() {
  return (
    <div className="match-details" aria-busy="true">
      <main className="md-page md-page--y">
        <section className="md-hero md-hero--skeleton" />
        <div className="md-card md-card--skeleton" />
      </main>
    </div>
  )
}

function MatchDetailsPage({ view, matchId }: { view: MatchView; matchId: string }) {
  const [shareOpen, setShareOpen] = useState(false)
  // Rating sparklines, H2H, comments, and the share modal are part of the
  // design handoff but have no real data behind them yet. The cards and their
  // render sites are gated off; flip this once each one's data lands.
  const showAuxCards = false

  return (
    <div className="match-details">
      <main className="md-page md-page--y">
        <div className="md-header">
          <Breadcrumb matchId={matchId} />
          <div className="md-header__right">
            {view.scoreCta && (
              <Link
                {...scoringNewRoute(view.scoreCta.matchId, view.scoreCta.gameId)}
                className="md-btn md-btn--primary md-btn--sm"
              >
                Score
              </Link>
            )}
            {showAuxCards && (
              <button
                type="button"
                className="md-btn md-btn--ghost md-btn--sm"
                onClick={() => setShareOpen(true)}
              >
                <Share2 size={14} /> Share
              </button>
            )}
          </div>
        </div>

        <HeroScoreboard view={view} matchId={matchId} />

        <div className="md-col-2">
          <div className="md-col-2__main">
            <PlayersCard view={view} />
            {showAuxCards && <CommentsCard />}
          </div>
          <aside className="md-col-2__aside">
            <MatchInfoCard view={view} />
            {showAuxCards && <RatingCard />}
            {showAuxCards && <H2HCard />}
          </aside>
        </div>

        <footer className="md-footer">
          <div className="md-footer__tagline">
            <Logo size={20} />
            <span>The math is quiet. The rallies are loud.</span>
          </div>
          <div className="md-footer__links">
            <a>Manifesto</a>
            <a>Open source</a>
            <a>Made by players</a>
          </div>
        </footer>
      </main>

      {showAuxCards && (
        <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
      )}
    </div>
  )
}

function Logo({ size = 26 }: { size?: number }) {
  return (
    <div className="md-logo">
      <svg width={size} height={size} viewBox="0 0 80 80" aria-hidden="true">
        <defs>
          <radialGradient id="md-logo-grad" cx="35%" cy="35%" r="65%">
            <stop offset="0%" stopColor="#FFB57A" />
            <stop offset="55%" stopColor="#FF7A1A" />
            <stop offset="100%" stopColor="#B94700" />
          </radialGradient>
        </defs>
        <circle cx="40" cy="40" r="36" fill="url(#md-logo-grad)" />
        <ellipse cx="30" cy="28" rx="10" ry="6" fill="#FFF" fillOpacity="0.22" />
      </svg>
      <span className="md-logo__word" style={{ fontSize: size * 0.95 }}>
        FORTYMM<span className="accent">.</span>
      </span>
    </div>
  )
}

function Breadcrumb({ matchId }: { matchId: string }) {
  return (
    <div className="md-breadcrumb">
      <Link to="/matches">Matches</Link>
      <span>›</span>
      <span className="md-breadcrumb__current">Match {matchId.slice(0, 6)}</span>
    </div>
  )
}

function HeroScoreboard({
  view,
  matchId,
}: {
  view: MatchView
  matchId: string
}) {
  const isLive = view.state === 'live'
  const isUpcoming = view.state === 'upcoming'

  return (
    <section className="md-hero">
      <div className="md-hero__grid-bg" aria-hidden="true" />

      <div className="md-hero__strip">
        <div className="md-hero__strip-l">
          {isLive && view.currentGameNumber !== null && (
            <span className="md-chip md-chip--live">
              <span className="dot" />
              Live · Game {view.currentGameNumber}
            </span>
          )}
          {view.state === 'final' && (
            <span className="md-chip md-chip--final">
              <span className="dot" />
              Final
            </span>
          )}
          {isUpcoming && (
            <span className="md-chip md-chip--upcoming">
              <span className="dot" />
              {view.statusLabel}
            </span>
          )}
        </div>
        <div className="md-hero__strip-r">
          <span className="md-hero__strip-meta">
            SINGLES · BO{view.bestOf}
          </span>
          {!isUpcoming && (
            <span className="md-hero__strip-meta md-hero__strip-meta--with-icon">
              <Clock size={13} strokeWidth={1.75} />
              First to {view.gamesToWin}
            </span>
          )}
        </div>
      </div>

      <div className="md-hero__row">
        <PlayerSide side={view.mySide} pos="l" />
        <div className="md-hero__score-block">
          {isUpcoming ? (
            <>
              <div className="md-hero__vs-label">VS</div>
              <div className="md-hero__vs-dash">—</div>
              <div className="md-hero__vs-label">{view.statusLabel}</div>
            </>
          ) : (
            <>
              <div className="md-hero__score-row">
                <div
                  className={cn(
                    'md-hero__score md-hero__score--l',
                    view.mySide.won && 'md-hero__score--win',
                  )}
                >
                  {view.mySide.gamesWon}
                </div>
                <div className="md-hero__score-dash">—</div>
                <div
                  className={cn(
                    'md-hero__score md-hero__score--r',
                    view.opponentSide?.won && 'md-hero__score--win',
                  )}
                >
                  {view.opponentSide?.gamesWon ?? 0}
                </div>
              </div>
              <div className="md-hero__score-caption">{view.statusLabel}</div>
            </>
          )}
        </div>
        {view.opponentSide && <PlayerSide side={view.opponentSide} pos="r" />}
      </div>

      {!isUpcoming && view.opponentSide && (
        <GameGrid view={view} matchId={matchId} />
      )}
    </section>
  )
}

function PlayerSide({ side, pos }: { side: SideView; pos: 'l' | 'r' }) {
  const win = side.won === true
  const change = side.ratingChange
  return (
    <div className={`md-hero__player md-hero__player--${pos}`}>
      <div className="md-hero__player-row">
        <div
          className={cn(
            'md-avatar md-hero__avatar-singles',
            win ? 'md-avatar--win' : 'md-avatar--loss',
          )}
        >
          {side.initials}
        </div>
        <div className={`md-hero__player-text--${pos}`}>
          <div className={cn('md-hero__name', win && 'md-hero__name--win')}>
            {side.username}
          </div>
          {change && (
            <div
              className={cn(
                'md-hero__rating-delta',
                change.delta >= 0
                  ? 'md-hero__rating-delta--up'
                  : 'md-hero__rating-delta--down',
              )}
              data-testid={`rating-delta-${pos}`}
            >
              {formatRatingDelta(change.delta)} rating
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function GameGrid({ view, matchId }: { view: MatchView; matchId: string }) {
  // Pad to best_of so the grid always renders the same number of cells.
  const slots: Array<GameView | null> = []
  for (let n = 1; n <= view.bestOf; n += 1) {
    slots.push(view.games.find((g) => g.gameNumber === n) ?? null)
  }
  return (
    <div className="md-games">
      <div className="md-games__grid">
        <div className="md-games__kicker">GAMES</div>
        {slots.map((_, i) => (
          <div key={`h-${i}`} className="md-games__col-label">
            G{i + 1}
          </div>
        ))}
        <div className="md-games__col-label">SETS</div>

        <GameGridSide
          side={view.mySide}
          slots={slots}
          mineSide
          matchId={matchId}
          currentGameNumber={view.currentGameNumber}
        />
        {view.opponentSide && (
          <GameGridSide
            side={view.opponentSide}
            slots={slots}
            mineSide={false}
            matchId={matchId}
            currentGameNumber={view.currentGameNumber}
          />
        )}
      </div>
    </div>
  )
}

function GameGridSide({
  side,
  slots,
  mineSide,
  matchId,
  currentGameNumber,
}: {
  side: SideView
  slots: Array<GameView | null>
  mineSide: boolean
  matchId: string
  currentGameNumber: number | null
}) {
  const won = side.won === true
  return (
    <>
      <div className="md-games__player">
        <span className={cn('md-avatar', won ? 'md-avatar--win' : 'md-avatar--loss')}>
          {side.initials}
        </span>
        <span className="md-games__player-name">{side.username}</span>
      </div>
      {slots.map((g, i) => {
        if (!g) {
          return (
            <div key={i} className="md-games__cell md-games__cell--empty">
              —
            </div>
          )
        }
        if (!g.score) {
          const isLiveCell = currentGameNumber === g.gameNumber
          return (
            <div
              key={i}
              className={cn(
                'md-games__cell md-games__cell--empty',
                isLiveCell && 'md-games__cell--live',
              )}
            >
              —
            </div>
          )
        }
        const cellWin = mineSide ? g.score.isMyWin : !g.score.isMyWin
        const value = mineSide ? g.score.mine : g.score.opponent
        const editTo = g.scoreId
          ? scoringEditRoute(matchId, g.id, g.scoreId)
          : null
        const className = cn(
          'md-games__cell',
          cellWin ? 'md-games__cell--win' : 'md-games__cell--loss',
        )
        // Only render the per-cell edit link once per game (on my row) so the
        // user doesn't see two stacked links over the same cell.
        if (mineSide && editTo) {
          return (
            <Link key={i} {...editTo} className={className}>
              {value}
            </Link>
          )
        }
        return (
          <div key={i} className={className}>
            {value}
          </div>
        )
      })}
      <div className={cn('md-games__total', won && 'md-games__total--win')}>
        {side.gamesWon}
      </div>
    </>
  )
}

function PlayersCard({ view }: { view: MatchView }) {
  return (
    <div className="md-card">
      <div className="md-card__hd">
        <h3>Players</h3>
      </div>
      <div className="md-players">
        <PlayerProfile side={view.mySide} won={view.mySide.won === true} />
        <div className="md-players__divider" />
        {view.opponentSide && (
          <PlayerProfile
            side={view.opponentSide}
            won={view.opponentSide.won === true}
          />
        )}
      </div>
    </div>
  )
}

function PlayerProfile({ side, won }: { side: SideView; won: boolean }) {
  return (
    <div className="md-profile">
      <div className="md-profile__identity">
        <div className={cn('md-avatar', won ? 'md-avatar--win' : 'md-avatar--loss')}>
          {side.initials}
        </div>
        <div className="md-profile__id-text">
          <div className="md-profile__name">{side.username}</div>
        </div>
      </div>
    </div>
  )
}

function MatchInfoCard({ view }: { view: MatchView }) {
  const rows: Array<[string, string]> = [
    ['Format', `Singles · Best of ${view.bestOf}, first to ${view.gamesToWin}`],
    ['Status', view.statusLabel],
    ['Rated', view.rated ? 'Yes' : 'No'],
  ]
  return (
    <div className="md-card">
      <div className="md-card__hd"><h3>Match info</h3></div>
      <div className="md-card__body">
        {rows.map(([k, v]) => (
          <div key={k} className="md-info-row">
            <span className="md-info-row__k">{k}</span>
            <span className="md-info-row__v">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RatingCard() {
  return null
}

function H2HCard() {
  return null
}

function CommentsCard() {
  return null
}

function ShareModal({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const url = typeof window !== 'undefined' ? window.location.href : ''

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(
    () => () => {
      if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    },
    [],
  )

  if (!open) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // Best-effort fallback; ignore the failure.
    }
    setCopied(true)
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    copyResetTimer.current = setTimeout(() => setCopied(false), 2200)
  }

  return (
    <div className="md-modal-scrim" onClick={onClose}>
      <div className="md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="md-modal__hd">
          <div>
            <div className="md-kicker">● Share match</div>
            <div className="md-modal__title" style={{ marginTop: 4 }}>
              One link. Anyone can view.
            </div>
          </div>
          <button
            type="button"
            className="md-btn md-btn--ghost md-btn--icon md-btn--sm"
            onClick={onClose}
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="md-modal__body">
          <div className="md-modal__url-row">
            <div className="md-modal__url">{url}</div>
            <button
              type="button"
              className="md-btn md-btn--primary"
              onClick={copy}
            >
              {copied ? (
                <><Check size={14} /> Copied</>
              ) : (
                <><Copy size={14} /> Copy</>
              )}
            </button>
          </div>
          <div className="md-modal__tiles">
            <ShareTile icon={<Send size={16} />} label="Post on X" hint="" />
            <ShareTile icon={<Link2 size={16} />} label="Embed" hint="iframe" />
            <ShareTile icon={<Download size={16} />} label="Save PNG" hint="" />
          </div>
        </div>
      </div>
    </div>
  )
}

function ShareTile({
  icon,
  label,
  hint,
}: {
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <button type="button" className="md-share-tile">
      {icon}
      <div style={{ textAlign: 'left' }}>
        <div className="md-share-tile__label">{label}</div>
        <div className="md-share-tile__hint">{hint}</div>
      </div>
    </button>
  )
}
