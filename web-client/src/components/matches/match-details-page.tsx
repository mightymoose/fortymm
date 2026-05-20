import { useEffect, useRef, useState } from 'react'
import { Link, Navigate, useRouter } from '@tanstack/react-router'
import {
  Check,
  ChevronRight,
  Clock,
  Copy,
  Download,
  Link2,
  Send,
  Share2,
  X,
} from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import { Overline } from '@/components/overline'
import { cn, initialsOf } from '@/lib/utils'
import { fmtDateShort } from '@/lib/dates'
import { formatRatingDelta } from '@/lib/rating'
import { scoringEditRoute, scoringNewRoute, useMatch } from '@/api/matches'
import type { components } from '@/api/schema'
import { ApiError } from '@/api/client'

type MatchDetails = components['schemas']['MatchDetails']
type MatchDetailsGame = components['schemas']['MatchDetailsGame']
type MatchDetailsSide = components['schemas']['MatchDetailsSide']
type MatchDetailsFormResult = components['schemas']['MatchDetailsFormResult']
type MatchDetailsPlayerForm = components['schemas']['MatchDetailsPlayerForm']
type MatchDetailsH2H = components['schemas']['MatchDetailsH2H']
type MatchDetailsH2HMeeting = components['schemas']['MatchDetailsH2HMeeting']
type RatingChange = components['schemas']['RatingChange']

const EMPTY_FORM: MatchDetailsPlayerForm = {
  user_id: '',
  recent_results: [],
  rating_before: null,
  rating_history: [],
  career_matches_before: 0,
  career_wins_before: 0,
}

type HeroState = 'live' | 'final' | 'upcoming'

type SideView = {
  sideNumber: number
  username: string
  userId: string | null
  initials: string
  gamesWon: number
  won: boolean | null
  isCurrentUser: boolean
  ratingChange: RatingChange | null
  recentForm: MatchDetailsFormResult[]
  ratingBefore: number | null
  ratingHistory: number[]
  careerMatchesBefore: number
  careerWinsBefore: number
}

type GameView = {
  id: string
  gameNumber: number
  // `null` for an un-scored trailing game.
  score: { leftPoints: number; rightPoints: number; leftWon: boolean } | null
  // The full score record for an edit-link affordance. Null when the game
  // hasn't been scored yet.
  scoreId: string | null
}

type H2HMeetingView = {
  matchId: string
  completedAt: string
  leftGamesWon: number
  rightGamesWon: number
  winnerSideNumber: number | null
}

type H2HView = {
  totalMeetings: number
  leftWins: number
  rightWins: number
  recentMeetings: H2HMeetingView[]
}

type MatchView = {
  state: HeroState
  statusLabel: string
  bestOf: number
  gamesToWin: number
  rated: boolean
  // Left/right are perspective-relative: when the current user is on a side
  // they're left (and `leftSide.isCurrentUser` is true); otherwise left = side
  // 1, right = side 2.
  leftSide: SideView
  rightSide: SideView | null
  games: GameView[]
  currentGameNumber: number | null
  canScore: boolean
  scoreCta: { matchId: string; gameId: string } | null
  headToHead: H2HView | null
}

function projectSide(
  side: MatchDetailsSide,
  fallbackLabel: string,
  form: MatchDetailsPlayerForm,
): SideView {
  const player = side.players[0]
  const username = player?.username ?? fallbackLabel
  return {
    sideNumber: side.side_number,
    username,
    userId: player?.user_id ?? null,
    initials: initialsOf(username),
    gamesWon: side.games_won,
    won: side.won,
    isCurrentUser: side.is_current_user_side,
    ratingChange: side.rating_change ?? null,
    recentForm: form.recent_results,
    ratingBefore: form.rating_before ?? null,
    ratingHistory: form.rating_history ?? [],
    careerMatchesBefore: form.career_matches_before,
    careerWinsBefore: form.career_wins_before,
  }
}

function orderSides(sides: MatchDetailsSide[]): {
  leftSide: MatchDetailsSide
  rightSide: MatchDetailsSide | null
} {
  const bySideNumber = [...sides].sort(
    (a, b) => a.side_number - b.side_number,
  )
  const mine = bySideNumber.find((s) => s.is_current_user_side)
  if (mine) {
    const opp = bySideNumber.find((s) => !s.is_current_user_side) ?? null
    return { leftSide: mine, rightSide: opp }
  }
  return {
    leftSide: bySideNumber[0],
    rightSide: bySideNumber[1] ?? null,
  }
}

function projectGame(
  game: MatchDetailsGame,
  leftSideNumber: number,
): GameView {
  const score = game.score
  if (!score)
    return { id: game.id, gameNumber: game.game_number, score: null, scoreId: null }
  const leftPoints =
    leftSideNumber === 1 ? score.side_1_points : score.side_2_points
  const rightPoints =
    leftSideNumber === 1 ? score.side_2_points : score.side_1_points
  return {
    id: game.id,
    gameNumber: game.game_number,
    score: {
      leftPoints,
      rightPoints,
      leftWon: score.winner_side_number === leftSideNumber,
    },
    scoreId: score.id,
  }
}

function formForUser(
  data: MatchDetails,
  userId: string | null,
): MatchDetailsPlayerForm {
  if (!userId) return EMPTY_FORM
  return data.recent_form?.find((f) => f.user_id === userId) ?? EMPTY_FORM
}

function projectHeadToHead(
  raw: MatchDetailsH2H | null | undefined,
  leftSideNumber: number,
): H2HView | null {
  if (!raw) return null
  const swap = leftSideNumber !== 1
  const recentMeetings: H2HMeetingView[] = raw.recent_meetings.map(
    (m: MatchDetailsH2HMeeting) => ({
      matchId: m.match_id,
      completedAt: m.completed_at,
      leftGamesWon: swap ? m.side_2_games_won : m.side_1_games_won,
      rightGamesWon: swap ? m.side_1_games_won : m.side_2_games_won,
      // API frames winner_side_number against *this* match's sides, which
      // are also our left/right anchor — no remap needed.
      winnerSideNumber: m.winner_side_number,
    }),
  )
  return {
    totalMeetings: raw.total_meetings,
    leftWins: swap ? raw.side_2_wins : raw.side_1_wins,
    rightWins: swap ? raw.side_1_wins : raw.side_2_wins,
    recentMeetings,
  }
}

function projectMatchView(data: MatchDetails, matchId: string): MatchView {
  const state: HeroState =
    data.status === 'in_progress'
      ? 'live'
      : data.status === 'completed'
        ? 'final'
        : 'upcoming'
  const { leftSide, rightSide } = orderSides(data.sides)
  const viewerIsParticipant = leftSide.is_current_user_side
  const leftLabel = viewerIsParticipant ? 'You' : 'Side 1'
  const rightLabel = viewerIsParticipant ? 'Opponent' : 'Side 2'
  const leftView = projectSide(
    leftSide,
    leftLabel,
    formForUser(data, leftSide.players[0]?.user_id ?? null),
  )
  const rightView = rightSide
    ? projectSide(
        rightSide,
        rightLabel,
        formForUser(data, rightSide.players[0]?.user_id ?? null),
      )
    : null
  const games = data.games
    .slice()
    .sort((a, b) => a.game_number - b.game_number)
    .map((g) => projectGame(g, leftView.sideNumber))
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
    leftSide: leftView,
    rightSide: rightView,
    games,
    currentGameNumber: data.current_game?.game_number ?? null,
    canScore: data.can_score,
    scoreCta,
    headToHead: projectHeadToHead(data.head_to_head, leftView.sideNumber),
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

  if (data.sides.length < 2) {
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
  // Any client error (404 no-such-match, 422 malformed id, …) means there's no
  // viewable match at this URL — show the friendly copy and never leak the raw
  // API detail (e.g. the pydantic "Input should be a valid UUID" string, #152).
  // Retrying the same URL won't help, so offer a way back to the list instead.
  const notFound = status >= 400 && status < 500
  const message = notFound
    ? "We couldn't find that match."
    : 'Something went wrong loading this match.'
  return (
    <AppShell>
      <div role="alert" className="md-error-state">
        <div className="md-error-state__title">{message}</div>
        {notFound ? (
          <Link to="/matches" className="md-btn md-btn--secondary">
            Back to matches
          </Link>
        ) : (
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
        )}
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
  // Comments + share modal are still part of the design handoff but have no
  // real data behind them yet; gate them off and flip when each lands.
  const showAuxCards = false
  const showRatingCard =
    view.leftSide.ratingChange !== null ||
    view.rightSide?.ratingChange != null

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
            {showRatingCard && <RatingCard view={view} />}
            {view.headToHead && (
              <H2HCard view={view} h2h={view.headToHead} />
            )}
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
        <PlayerSide side={view.leftSide} pos="l" />
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
                    view.leftSide.won && 'md-hero__score--win',
                  )}
                >
                  {view.leftSide.gamesWon}
                </div>
                <div className="md-hero__score-dash">—</div>
                <div
                  className={cn(
                    'md-hero__score md-hero__score--r',
                    view.rightSide?.won && 'md-hero__score--win',
                  )}
                >
                  {view.rightSide?.gamesWon ?? 0}
                </div>
              </div>
              <div className="md-hero__score-caption">{view.statusLabel}</div>
            </>
          )}
        </div>
        {view.rightSide && <PlayerSide side={view.rightSide} pos="r" />}
      </div>

      {!isUpcoming && view.rightSide && (
        <GameGrid view={view} matchId={matchId} />
      )}
    </section>
  )
}

function PlayerSide({ side, pos }: { side: SideView; pos: 'l' | 'r' }) {
  const win = side.won === true
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
  // Per-cell edit links are gated on participation — spectators can't write
  // scores, so the row never wraps cells in `<Link>`s for them.
  const canEdit = view.leftSide.isCurrentUser
  return (
    <div className="md-games">
      <div
        className="md-games__grid"
        style={{ '--md-games-count': view.bestOf } as React.CSSProperties}
      >
        <div className="md-games__kicker">GAMES</div>
        {slots.map((_, i) => (
          <div key={`h-${i}`} className="md-games__col-label">
            G{i + 1}
          </div>
        ))}
        <div className="md-games__col-label">SETS</div>

        <GameGridSide
          side={view.leftSide}
          slots={slots}
          rowSide="left"
          matchId={matchId}
          currentGameNumber={view.currentGameNumber}
          canEdit={canEdit}
        />
        {view.rightSide && (
          <GameGridSide
            side={view.rightSide}
            slots={slots}
            rowSide="right"
            matchId={matchId}
            currentGameNumber={view.currentGameNumber}
            canEdit={false}
          />
        )}
      </div>
    </div>
  )
}

function GameGridSide({
  side,
  slots,
  rowSide,
  matchId,
  currentGameNumber,
  canEdit,
}: {
  side: SideView
  slots: Array<GameView | null>
  rowSide: 'left' | 'right'
  matchId: string
  currentGameNumber: number | null
  canEdit: boolean
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
        const cellWin =
          rowSide === 'left' ? g.score.leftWon : !g.score.leftWon
        const value =
          rowSide === 'left' ? g.score.leftPoints : g.score.rightPoints
        const editTo =
          canEdit && g.scoreId
            ? scoringEditRoute(matchId, g.id, g.scoreId)
            : null
        const className = cn(
          'md-games__cell',
          cellWin ? 'md-games__cell--win' : 'md-games__cell--loss',
        )
        // Only render the per-cell edit link on the participant's own row so
        // the user doesn't see two stacked links over the same cell.
        if (editTo) {
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
        <Overline as="h3">Players &amp; form</Overline>
        <span className="md-card__hd-meta">LAST 5 RESULTS</span>
      </div>
      <div className="md-players">
        <PlayerProfile side={view.leftSide} won={view.leftSide.won === true} />
        <div className="md-players__divider" />
        {view.rightSide && (
          <PlayerProfile
            side={view.rightSide}
            won={view.rightSide.won === true}
          />
        )}
      </div>
    </div>
  )
}

function PlayerProfile({ side, won }: { side: SideView; won: boolean }) {
  const form = side.recentForm
  const wins = form.filter((r) => r.is_win).length
  const losses = form.length - wins
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
      <RatingBox side={side} />
      <div className="md-profile__form" data-testid={`form-${side.sideNumber}`}>
        <div className="md-kicker">
          {form.length === 0
            ? 'Recent form'
            : `Recent form · ${wins}–${losses}`}
        </div>
        {form.length === 0 ? (
          <div className="md-profile__empty">
            No prior matches yet — this is{' '}
            {side.isCurrentUser ? 'your' : 'their'} first one.
          </div>
        ) : (
          <ul className="md-profile__form-list">
            {form.map((r) => (
              <FormRow key={r.match_id} result={r} />
            ))}
          </ul>
        )}
      </div>
      <CareerStats side={side} />
    </div>
  )
}

function RatingBox({ side }: { side: SideView }) {
  const value = side.ratingBefore
  return (
    <div
      className="md-profile__rating-box"
      data-testid={`rating-box-${side.sideNumber}`}
    >
      <div>
        <div className="md-kicker">Rating</div>
        <div className="md-profile__rating-value">
          {value === null ? <span className="dim">Unrated</span> : Math.round(value)}
        </div>
      </div>
      {side.ratingHistory.length >= 2 && (
        <Sparkline data={side.ratingHistory} />
      )}
    </div>
  )
}

function Sparkline({
  data,
  w = 110,
  h = 36,
  downColor = 'var(--fg-3)',
}: {
  data: number[]
  w?: number
  h?: number
  downColor?: string
}) {
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2
  const points = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (w - pad * 2)
    const y = h - pad - ((v - min) / range) * (h - pad * 2)
    return [x, y] as const
  })
  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`)
    .join(' ')
  // The last point's trend picks the colour so a falling rating reads as a
  // loss tone even before the user squints at the y-axis.
  const trendUp = data[data.length - 1] >= data[0]
  const color = trendUp ? 'var(--serve-500)' : downColor
  const last = points[points.length - 1]
  return (
    <svg
      width={w}
      height={h}
      style={{ display: 'block', overflow: 'visible' }}
      aria-hidden="true"
    >
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last[0]} cy={last[1]} r="2.4" fill={color} />
    </svg>
  )
}

function CareerStats({ side }: { side: SideView }) {
  const matches = side.careerMatchesBefore
  const winRate =
    matches > 0 ? Math.round((side.careerWinsBefore / matches) * 100) : null
  return (
    <div
      className="md-profile__career"
      data-testid={`career-${side.sideNumber}`}
    >
      <div>
        <div className="md-kicker">Career matches</div>
        <div className="md-profile__career-value">{matches}</div>
      </div>
      <div>
        <div className="md-kicker">Win rate</div>
        <div
          className={cn(
            'md-profile__career-value',
            winRate !== null &&
              winRate >= 50 &&
              'md-profile__career-value--good',
          )}
        >
          {winRate === null ? <span className="dim">—</span> : `${winRate}%`}
        </div>
      </div>
    </div>
  )
}

function FormRow({ result }: { result: MatchDetailsFormResult }) {
  const win = result.is_win
  const score = `${result.player_games_won}–${result.opponent_games_won}`
  const opponentLabel = result.opponent_username ?? 'No opponent'
  return (
    <li className="md-form-row">
      <span
        className={cn(
          'md-form-row__badge',
          win ? 'md-form-row__badge--w' : 'md-form-row__badge--l',
        )}
      >
        {win ? 'W' : 'L'}
      </span>
      <span className="md-form-row__opp" title={opponentLabel}>
        <span className="md-form-row__opp-name">{opponentLabel}</span>
        <span className="md-form-row__when">{fmtDateShort(result.completed_at)}</span>
      </span>
      <span
        className={cn(
          'md-form-row__score',
          !win && 'md-form-row__score--loss',
        )}
      >
        {score}
      </span>
    </li>
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
      <div className="md-card__hd"><Overline as="h3">Match info</Overline></div>
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

function RatingCard({ view }: { view: MatchView }) {
  const sides = [view.leftSide, view.rightSide].filter(
    (s): s is SideView => s !== null,
  )
  return (
    <div className="md-card">
      <div className="md-card__hd">
        <Overline as="h3">Rating change</Overline>
      </div>
      <div className="md-card__body md-rating-card__body">
        {sides.map((side, i) => (
          <RatingRow key={side.sideNumber} side={side} isFirst={i === 0} />
        ))}
      </div>
    </div>
  )
}

function RatingRow({ side, isFirst }: { side: SideView; isFirst: boolean }) {
  const change = side.ratingChange
  const won = side.won === true
  return (
    <>
      {!isFirst && <hr className="md-rating-divider" />}
      <div className="md-rating-row">
        <div
          className={cn(
            'md-avatar',
            won ? 'md-avatar--win' : 'md-avatar--loss',
          )}
        >
          {side.initials}
        </div>
        <div className="md-rating-row__text">
          <div className="md-rating-row__name">{side.username}</div>
          {change ? (
            <div className="md-rating-row__numbers">
              {change.before !== null && (
                <span className="from">{Math.round(change.before)}</span>
              )}
              <ChevronRight size={11} strokeWidth={1.75} />
              <span className="to">{Math.round(change.after)}</span>
            </div>
          ) : (
            <div className="md-rating-row__numbers">
              <span className="from">Rating updates when the match ends</span>
            </div>
          )}
        </div>
        {change && (
          <div className="md-rating-row__delta">
            <RatingRowSparkline
              history={side.ratingHistory}
              change={change}
            />
            <span
              className={cn(
                'md-rating-row__delta-num',
                change.delta >= 0 ? 'md-delta-up' : 'md-delta-down',
              )}
            >
              {formatRatingDelta(change.delta)}
            </span>
          </div>
        )}
      </div>
    </>
  )
}

function RatingRowSparkline({
  history,
  change,
}: {
  history: number[]
  change: RatingChange
}) {
  // history is anchored "before this match"; append the post-match value so the
  // line lands on the new rating.
  const series = [...history]
  if (series.length === 0 && change.before !== null) {
    series.push(change.before)
  }
  series.push(change.after)
  if (series.length < 2) return null
  return <Sparkline data={series} w={80} h={28} downColor="var(--loss)" />
}

function H2HCard({ view, h2h }: { view: MatchView; h2h: H2HView }) {
  const leftLabel = view.leftSide.username
  const rightLabel = view.rightSide?.username ?? 'Opponent'
  const hasMeetings = h2h.totalMeetings > 0
  return (
    <div className="md-card">
      <div className="md-card__hd">
        <Overline as="h3">Head to head</Overline>
        <span className="md-card__hd-meta">
          {h2h.totalMeetings} {h2h.totalMeetings === 1 ? 'MEETING' : 'MEETINGS'}
        </span>
      </div>
      <div className="md-card__body md-h2h">
        <div className="md-h2h__counts">
          <div className="md-h2h__count-label md-h2h__count-label--l">
            {leftLabel}
          </div>
          <div
            className={cn(
              'md-h2h__count',
              'md-h2h__count--l',
              h2h.leftWins > h2h.rightWins && 'md-h2h__count--win',
            )}
          >
            {h2h.leftWins}
          </div>
          <span className="md-h2h__sep">—</span>
          <div
            className={cn(
              'md-h2h__count',
              'md-h2h__count--r',
              h2h.rightWins > h2h.leftWins && 'md-h2h__count--win',
            )}
          >
            {h2h.rightWins}
          </div>
          <div className="md-h2h__count-label md-h2h__count-label--r">
            {rightLabel}
          </div>
        </div>
        {hasMeetings ? (
          <H2HMeetings h2h={h2h} leftSideNumber={view.leftSide.sideNumber} />
        ) : (
          <div className="md-h2h__empty">
            No prior meetings — this match is the start of the rivalry.
          </div>
        )}
      </div>
    </div>
  )
}

function H2HMeetings({
  h2h,
  leftSideNumber,
}: {
  h2h: H2HView
  leftSideNumber: number
}) {
  const totalDecided = h2h.leftWins + h2h.rightWins
  const leftPct = totalDecided > 0 ? (h2h.leftWins / totalDecided) * 100 : 0
  const rightPct = totalDecided > 0 ? (h2h.rightWins / totalDecided) * 100 : 0
  return (
    <>
      <div className="md-h2h__bar" aria-hidden="true">
        <div style={{ width: `${leftPct}%`, background: 'var(--serve-500)' }} />
        <div style={{ width: `${rightPct}%`, background: 'var(--ink-500)' }} />
      </div>
      <div>
        {h2h.recentMeetings.map((m) => (
          <H2HRow key={m.matchId} meeting={m} leftSideNumber={leftSideNumber} />
        ))}
      </div>
    </>
  )
}

function H2HRow({
  meeting,
  leftSideNumber,
}: {
  meeting: H2HMeetingView
  leftSideNumber: number
}) {
  const leftWon = meeting.winnerSideNumber === leftSideNumber
  return (
    <div className="md-h2h__row">
      <span className="md-h2h__date">{fmtDateShort(meeting.completedAt)}</span>
      <span className="md-h2h__label">Match</span>
      <span
        className={cn('md-h2h__score', leftWon && 'md-h2h__score--win')}
      >
        {meeting.leftGamesWon}–{meeting.rightGamesWon}
      </span>
      <span
        className={cn(
          'md-h2h__result',
          leftWon ? 'md-h2h__result--w' : 'md-h2h__result--l',
        )}
      >
        {leftWon ? 'W' : 'L'}
      </span>
    </div>
  )
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
