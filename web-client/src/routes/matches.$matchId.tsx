import { useEffect, useState, type FormEvent } from 'react'
import { createFileRoute } from '@tanstack/react-router'
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

export const Route = createFileRoute('/matches/$matchId')({
  component: MatchDetailsPage,
})

type MatchState = 'live' | 'final' | 'upcoming'
type Format = 'singles' | 'doubles'
type Context = 'tournament' | 'casual'

/* ---------- DATA (hard-coded from the design handoff) -------------------- */

const MATCH = {
  tournament: 'Spring Open 2026',
  round: 'Round of 16',
  matchNo: 14,
  court: 'Court 3',
  date: 'Sat · May 10, 2026',
  startedAt: '19:42',
  duration: '32:14',
  format: 'Best of 5 · Games to 11',
  referee: 'M. Larsson',
  umpire: 'A. Doyle',
  spectators: 184,
}

interface DoublesMember {
  first: string
  last: string
  initials: string
}

interface BasePlayer {
  id: 'a' | 'b'
  initials: string
  seed: number
  club: string
  country: string
}

interface SinglesPlayer extends BasePlayer {
  first: string
  last: string
}

interface DoublesPlayer extends BasePlayer {
  last: string
  members: DoublesMember[]
  rating: string
  ratingNew: string
  delta: number
}

const SINGLES_PLAYERS: Record<'a' | 'b', SinglesPlayer> = {
  a: { id: 'a', last: 'Nguyen', first: 'Thanh', initials: 'TN', seed: 1, club: 'Saigon TT', country: 'VN' },
  b: { id: 'b', last: 'Okafor', first: 'Daniel', initials: 'DO', seed: 8, club: 'Lagos Spin', country: 'NG' },
}

const DOUBLES_PLAYERS: Record<'a' | 'b', DoublesPlayer> = {
  a: {
    id: 'a',
    last: 'Nguyen / Patel',
    initials: 'NP',
    seed: 1,
    rating: '2145 / 1998',
    ratingNew: '+8 / +9',
    delta: 8.5,
    club: 'Saigon TT · Mumbai SC',
    country: 'VN',
    members: [
      { first: 'Thanh', last: 'Nguyen', initials: 'TN' },
      { first: 'Meera', last: 'Patel', initials: 'MP' },
    ],
  },
  b: {
    id: 'b',
    last: 'Okafor / Tanaka',
    initials: 'OT',
    seed: 5,
    rating: '2002 / 2070',
    ratingNew: '−7 / −8',
    delta: -7.5,
    club: 'Lagos Spin · Osaka Loops',
    country: 'NG',
    members: [
      { first: 'Daniel', last: 'Okafor', initials: 'DO' },
      { first: 'Yuki', last: 'Tanaka', initials: 'YT' },
    ],
  },
}

interface Scoreline {
  games: Array<[number, number]>
  winner: 'a' | 'b' | null
  summary: [number, number]
  currentGame?: number
  serving?: 'a' | 'b'
}

const SCORES_FINAL: Scoreline = { games: [[11, 6], [9, 11], [11, 8], [11, 9]], winner: 'a', summary: [3, 1] }
const SCORES_LIVE: Scoreline = { games: [[11, 6], [9, 11], [11, 8], [9, 8]], winner: null, summary: [2, 1], currentGame: 4, serving: 'a' }
const DOUBLES_FINAL: Scoreline = { games: [[11, 9], [8, 11], [11, 7], [9, 11], [11, 8]], winner: 'a', summary: [3, 2] }
const DOUBLES_LIVE: Scoreline = { games: [[11, 9], [8, 11], [11, 7], [7, 5]], winner: null, summary: [2, 1], currentGame: 4, serving: 'b' }

interface FormResult { r: 'W' | 'L'; score: string; opp: string; when: string }

const RECENT_FORM: Record<string, FormResult[]> = {
  a_singles: [
    { r: 'W', score: '3–0', opp: 'Silva, R.', when: 'May 10 · R32' },
    { r: 'W', score: '3–1', opp: 'Kim, H.', when: 'May 09 · R64' },
    { r: 'W', score: '3–2', opp: 'Hansen, M.', when: 'Apr 21 · Cup' },
    { r: 'L', score: '1–3', opp: 'Tanaka, Y.', when: 'Apr 06 · Reg.' },
    { r: 'W', score: '3–0', opp: 'Ali, R.', when: 'Mar 29 · Club' },
  ],
  b_singles: [
    { r: 'W', score: '3–2', opp: 'Dubois, C.', when: 'May 10 · R32' },
    { r: 'W', score: '3–0', opp: 'Ahmed, I.', when: 'May 09 · R64' },
    { r: 'L', score: '2–3', opp: 'Tran, L.', when: 'Apr 18 · Cup' },
    { r: 'L', score: '0–3', opp: 'Müller, F.', when: 'Apr 03 · Reg.' },
    { r: 'W', score: '3–1', opp: 'Park, J.', when: 'Mar 22 · Club' },
  ],
  a_doubles: [
    { r: 'W', score: '3–0', opp: 'Müller/Rossi', when: 'May 10 · R32' },
    { r: 'W', score: '3–1', opp: 'Ali/Park', when: 'May 09 · R64' },
    { r: 'W', score: '3–2', opp: 'Hansen/Kim', when: 'Apr 21 · Cup' },
    { r: 'L', score: '2–3', opp: 'Tanaka/Yoon', when: 'Apr 06 · Reg.' },
    { r: 'W', score: '3–0', opp: 'Silva/Dubois', when: 'Mar 29 · Club' },
  ],
  b_doubles: [
    { r: 'W', score: '3–2', opp: 'Chen/Wong', when: 'May 10 · R32' },
    { r: 'L', score: '1–3', opp: 'Patel/Mehta', when: 'May 09 · R64' },
    { r: 'L', score: '2–3', opp: 'Tran/Le', when: 'Apr 18 · Cup' },
    { r: 'W', score: '3–0', opp: 'Doe/Roe', when: 'Apr 03 · Reg.' },
    { r: 'W', score: '3–1', opp: 'Park/Yoon', when: 'Mar 22 · Club' },
  ],
}

const RATING_HISTORY: Record<string, number[]> = {
  a_singles: [2098, 2104, 2110, 2118, 2128, 2122, 2120, 2132, 2140, 2145],
  b_singles: [2080, 2074, 2065, 2050, 2052, 2040, 2018, 2012, 2008, 2002],
  a_doubles: [2042, 2050, 2058, 2062, 2058, 2068, 2074, 2078, 2084, 2092],
  b_doubles: [2050, 2048, 2052, 2048, 2044, 2052, 2050, 2042, 2038, 2036],
}

const CAREER: Record<string, { matches: number; winPct: number }> = {
  a_singles: { matches: 184, winPct: 71 },
  b_singles: { matches: 162, winPct: 62 },
  a_doubles: { matches: 92, winPct: 68 },
  b_doubles: { matches: 78, winPct: 55 },
}

interface H2HMatch {
  id: string
  date: string
  round: string
  score: [number, number]
  winner: 'a' | 'b'
  tonight?: boolean
}

const H2H: { total: number; aWins: number; bWins: number; matches: H2HMatch[] } = {
  total: 6,
  aWins: 4,
  bWins: 2,
  matches: [
    { id: 'spring-open-2026-r16', date: '2026-05-10', round: 'Spring Open · R16', score: [3, 1], winner: 'a', tonight: true },
    { id: 'autumn-cup-2025-qf', date: '2025-11-22', round: 'Autumn Cup · QF', score: [3, 2], winner: 'a' },
    { id: 'summer-slam-2025-f', date: '2025-08-04', round: 'Summer Slam · F', score: [1, 3], winner: 'b' },
    { id: 'friendly-2025-03', date: '2025-03-17', round: 'Friendly · BO5', score: [3, 0], winner: 'a' },
    { id: 'regional-2024-sf', date: '2024-10-08', round: 'Regional · SF', score: [2, 3], winner: 'b' },
    { id: 'club-night-2024-06', date: '2024-06-21', round: 'Club night · BO3', score: [2, 1], winner: 'a' },
  ],
}

interface Comment {
  who: string
  initials: string
  when: string
  body: string
  reacts: { ball: number; fire: number }
  yours: { ball: boolean; fire: boolean }
}

const COMMENTS_INIT: Comment[] = [
  { who: 'Kim, Hyun', initials: 'KH', when: '2 min ago', body: 'What a comeback in G2 — that 9-11 swing was unreal. Nguyen looked rattled and then just locked in.', reacts: { ball: 12, fire: 4 }, yours: { ball: false, fire: false } },
  { who: 'Park, Joon', initials: 'PJ', when: '12 min ago', body: 'His backhand block down the line on point 6 of G3 should be a poster.', reacts: { ball: 18, fire: 9 }, yours: { ball: true, fire: false } },
  { who: 'Silva, Renata', initials: 'SR', when: '22 min ago', body: 'Watching from Toronto. GG, both. Daniel still played his heart out.', reacts: { ball: 6, fire: 2 }, yours: { ball: false, fire: false } },
  { who: 'Patel, Meera', initials: 'MP', when: '35 min ago', body: 'Court 3 has the best view in the building. Fight me.', reacts: { ball: 24, fire: 11 }, yours: { ball: false, fire: true } },
]

/* ---------- Shared bits --------------------------------------------------- */

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

function FlagBadge({ code }: { code: string }) {
  return <span className="md-hero__flag">{code}</span>
}

function Sparkline({ points, color = 'currentColor', width = 120, height = 32 }: { points: number[]; color?: string; width?: number; height?: number }) {
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = Math.max(1, max - min)
  const xs = points.map((_, i) => (i / (points.length - 1)) * width)
  const ys = points.map((p) => height - ((p - min) / span) * (height - 4) - 2)
  const d = xs.map((x, i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(' ')
  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }} aria-hidden="true">
      <path d={d} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={xs[xs.length - 1]} cy={ys[ys.length - 1]} r={2.5} fill={color} />
    </svg>
  )
}

/* ---------- Breadcrumb + tabs -------------------------------------------- */

function Breadcrumb({ context }: { context: Context }) {
  if (context === 'casual') {
    return (
      <div className="md-breadcrumb">
        <a>Saigon TT</a>
        <span>›</span>
        <span>Club night · May 10</span>
        <span>›</span>
        <span className="md-breadcrumb__current">Match #042</span>
      </div>
    )
  }
  return (
    <div className="md-breadcrumb">
      <a>Spring Open 2026</a>
      <span>›</span>
      <a>Day 2</a>
      <span>›</span>
      <a>Round of 16</a>
      <span>›</span>
      <span className="md-breadcrumb__current">Match #14</span>
    </div>
  )
}

/* ---------- Hero scoreboard ---------------------------------------------- */

function PlayerSide({
  player,
  win,
  side,
  state,
  serving,
  format,
}: {
  player: SinglesPlayer | DoublesPlayer
  win: boolean
  side: 'l' | 'r'
  state: MatchState
  serving: 'a' | 'b' | undefined
  format: Format
}) {
  const isDoubles = format === 'doubles'
  const doublesPlayer = isDoubles ? (player as DoublesPlayer) : null
  return (
    <div className={`md-hero__player md-hero__player--${side}`}>
      <div className="md-hero__player-row">
        {doublesPlayer ? (
          <div className={`md-hero__doubles-row md-hero__doubles-row--${side}`}>
            {doublesPlayer.members.map((m, i) => (
              <div
                key={i}
                className={`md-avatar ${win ? 'md-avatar--win' : 'md-avatar--loss'}`}
                style={{ zIndex: 2 - i }}
              >
                {m.initials}
              </div>
            ))}
          </div>
        ) : (
          <div className={`md-avatar md-hero__avatar-singles ${win ? 'md-avatar--win' : 'md-avatar--loss'}`}>
            {player.initials}
          </div>
        )}
        <div className={`md-hero__player-text--${side}`}>
          <div className="md-hero__meta">
            <span className="md-hero__seed">[{player.seed}]</span>
            <FlagBadge code={player.country} />
            {state === 'live' && serving === player.id && (
              <span className="md-hero__serving" title="Serving">
                <span className="ball-dot ball-dot--live" />
                SERVE
              </span>
            )}
          </div>
          <div className={`md-hero__name ${win ? 'md-hero__name--win' : ''}`}>
            {isDoubles ? player.last : `${(player as SinglesPlayer).last}, ${(player as SinglesPlayer).first}`}
          </div>
          <div className="md-hero__club">{player.club}</div>
        </div>
      </div>
    </div>
  )
}

function HeroScoreboard({ state, format, context }: { state: MatchState; format: Format; context: Context }) {
  const players = format === 'doubles' ? DOUBLES_PLAYERS : SINGLES_PLAYERS
  const score = state === 'live'
    ? (format === 'doubles' ? DOUBLES_LIVE : SCORES_LIVE)
    : (format === 'doubles' ? DOUBLES_FINAL : SCORES_FINAL)

  const isLive = state === 'live'
  const isUpcoming = state === 'upcoming'

  const aTotal = isUpcoming ? 0 : score.summary[0]
  const bTotal = isUpcoming ? 0 : score.summary[1]
  const winA = score.winner === 'a'
  const winB = score.winner === 'b'

  return (
    <section className="md-hero">
      <div className="md-hero__grid-bg" aria-hidden="true" />

      <div className="md-hero__strip">
        <div className="md-hero__strip-l">
          {isLive && (
            <span className="md-chip md-chip--live">
              <span className="dot" />
              Live · Game {score.currentGame}
            </span>
          )}
          {state === 'final' && (
            <span className="md-chip md-chip--final">
              <span className="dot" />
              Final
            </span>
          )}
          {isUpcoming && (
            <span className="md-chip md-chip--upcoming">
              <span className="dot" />
              Starts in 2h 14m
            </span>
          )}
          <span className="md-hero__strip-meta">
            {context === 'casual' ? 'CLUB NIGHT · TUE' : `${MATCH.round.toUpperCase()} · ${MATCH.court.toUpperCase()}`}
          </span>
        </div>
        <div className="md-hero__strip-r">
          <span className="md-hero__strip-meta">
            {format === 'doubles' ? 'DOUBLES' : 'SINGLES'} · BO5
          </span>
          {!isUpcoming && (
            <span className="md-hero__strip-meta md-hero__strip-meta--with-icon">
              <Clock size={13} strokeWidth={1.75} />
              {MATCH.duration}
            </span>
          )}
        </div>
      </div>

      <div className="md-hero__row">
        <PlayerSide player={players.a} win={winA} side="l" state={state} serving={score.serving} format={format} />
        <div className="md-hero__score-block">
          {isUpcoming ? (
            <>
              <div className="md-hero__vs-label">VS</div>
              <div className="md-hero__vs-dash">—</div>
              <div className="md-hero__vs-label">{MATCH.startedAt} · {MATCH.date.replace('Sat · ', '')}</div>
            </>
          ) : (
            <>
              <div className="md-hero__score-row">
                <div className={`md-hero__score md-hero__score--l ${winA ? 'md-hero__score--win' : ''}`}>{aTotal}</div>
                <div className="md-hero__score-dash">—</div>
                <div className={`md-hero__score md-hero__score--r ${winB ? 'md-hero__score--win' : ''}`}>{bTotal}</div>
              </div>
              <div className="md-hero__score-caption">
                {isLive
                  ? `IN PROGRESS · ${(score.games[(score.currentGame ?? 1) - 1] || []).join('–')}`
                  : MATCH.date}
              </div>
            </>
          )}
        </div>
        <PlayerSide player={players.b} win={winB} side="r" state={state} serving={score.serving} format={format} />
      </div>

      {!isUpcoming && <GameGrid score={score} players={players} state={state} />}
    </section>
  )
}

function GameGrid({
  score,
  players,
  state,
}: {
  score: Scoreline
  players: Record<'a' | 'b', SinglesPlayer | DoublesPlayer>
  state: MatchState
}) {
  const games = [0, 1, 2, 3, 4]
  const isLive = state === 'live'

  function nameOf(p: SinglesPlayer | DoublesPlayer): string {
    return (p.last || '').split('/')[0].trim()
  }

  return (
    <div className="md-games">
      <div className="md-games__grid">
        <div className="md-games__kicker">GAMES</div>
        {games.map((i) => (
          <div key={`h-${i}`} className="md-games__col-label">G{i + 1}</div>
        ))}
        <div className="md-games__col-label">SETS</div>

        <div className="md-games__player">
          <span className="md-avatar md-avatar--win">{players.a.initials}</span>
          <span className="md-games__player-name">{nameOf(players.a)}</span>
        </div>
        {games.map((i) => {
          const g = score.games[i]
          if (!g) return <div key={`a-${i}`} className="md-games__cell md-games__cell--empty">—</div>
          const isLiveCell = isLive && score.currentGame === i + 1
          return (
            <div
              key={`a-${i}`}
              className={`md-games__cell ${g[0] > g[1] ? 'md-games__cell--win' : 'md-games__cell--loss'} ${isLiveCell ? 'md-games__cell--live' : ''}`}
            >
              {g[0]}
            </div>
          )
        })}
        <div className={`md-games__total ${score.winner === 'a' ? 'md-games__total--win' : ''}`}>
          {score.summary[0]}
        </div>

        <div className="md-games__player">
          <span className="md-avatar md-avatar--loss">{players.b.initials}</span>
          <span className="md-games__player-name">{nameOf(players.b)}</span>
        </div>
        {games.map((i) => {
          const g = score.games[i]
          if (!g) return <div key={`b-${i}`} className="md-games__cell md-games__cell--empty">—</div>
          const isLiveCell = isLive && score.currentGame === i + 1
          return (
            <div
              key={`b-${i}`}
              className={`md-games__cell ${g[1] > g[0] ? 'md-games__cell--win' : 'md-games__cell--loss'} ${isLiveCell ? 'md-games__cell--live' : ''}`}
            >
              {g[1]}
            </div>
          )
        })}
        <div className={`md-games__total ${score.winner === 'b' ? 'md-games__total--win' : ''}`}>
          {score.summary[1]}
        </div>
      </div>
    </div>
  )
}

/* ---------- Players & form card ----------------------------------------- */

function PlayersCard({ state, format }: { state: MatchState; format: Format }) {
  const players = format === 'doubles' ? DOUBLES_PLAYERS : SINGLES_PLAYERS
  const aKey = format === 'doubles' ? 'a_doubles' : 'a_singles'
  const bKey = format === 'doubles' ? 'b_doubles' : 'b_singles'

  return (
    <div className="md-card">
      <div className="md-card__hd">
        <h3>{state === 'upcoming' ? 'Players' : 'Players & form'}</h3>
        <span className="md-modal__preview-sub" style={{ marginTop: 0 }}>LAST 5 RESULTS</span>
      </div>
      <div className="md-players">
        <PlayerProfile p={players.a} form={RECENT_FORM[aKey]} history={RATING_HISTORY[aKey]} career={CAREER[aKey]} format={format} won={state === 'final'} />
        <div className="md-players__divider" />
        <PlayerProfile p={players.b} form={RECENT_FORM[bKey]} history={RATING_HISTORY[bKey]} career={CAREER[bKey]} format={format} won={false} />
      </div>
    </div>
  )
}

function PlayerProfile({
  p,
  form,
  history,
  career,
  format,
  won,
}: {
  p: SinglesPlayer | DoublesPlayer
  form: FormResult[]
  history: number[]
  career: { matches: number; winPct: number }
  format: Format
  won: boolean
}) {
  const isDoubles = format === 'doubles'
  const doublesPlayer = isDoubles ? (p as DoublesPlayer) : null
  const wins = form.filter((f) => f.r === 'W').length
  const sparkColor = won ? 'var(--serve-500)' : 'var(--fg-3)'

  return (
    <div className="md-profile">
      <div className="md-profile__identity">
        {doublesPlayer ? (
          <div className="md-profile__doubles-avatars">
            {doublesPlayer.members.map((m, i) => (
              <div
                key={i}
                className={`md-avatar ${won ? 'md-avatar--win' : 'md-avatar--loss'}`}
                style={{ zIndex: 2 - i }}
              >
                {m.initials}
              </div>
            ))}
          </div>
        ) : (
          <div className={`md-avatar ${won ? 'md-avatar--win' : 'md-avatar--loss'}`}>
            {p.initials}
          </div>
        )}
        <div className="md-profile__id-text">
          <div className="md-profile__tag-row">
            <span className="md-profile__seed">[{p.seed}]</span>
            <FlagBadge code={p.country} />
          </div>
          <div className="md-profile__name">
            {isDoubles ? p.last : `${(p as SinglesPlayer).last}, ${(p as SinglesPlayer).first}`}
          </div>
          <div className="md-profile__club">{p.club}</div>
        </div>
      </div>

      <div className="md-profile__rating-box">
        <div>
          <div className="md-kicker">Rating</div>
          <div className="md-profile__rating-value">
            {history[history.length - 1]}
            {doublesPlayer && (
              <span className="dim"> · {doublesPlayer.members.map((m) => m.initials).join('/')}</span>
            )}
          </div>
        </div>
        <Sparkline points={history} color={sparkColor} width={88} height={32} />
      </div>

      <div>
        <div className="md-kicker" style={{ marginBottom: 8 }}>
          Recent form · {wins}–{5 - wins}
        </div>
        <div>
          {form.map((m, i) => (
            <div key={i} className="md-form-row">
              <span className={`md-form-row__badge md-form-row__badge--${m.r === 'W' ? 'w' : 'l'}`}>
                {m.r}
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="md-form-row__opp">{m.opp}</div>
                <div className="md-form-row__when">{m.when}</div>
              </div>
              <span className={`md-form-row__score ${m.r === 'L' ? 'md-form-row__score--loss' : ''}`}>
                {m.score}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="md-profile__career">
        <div>
          <div className="md-kicker">Career matches</div>
          <div className="md-profile__career-value">{career.matches}</div>
        </div>
        <div>
          <div className="md-kicker">Win rate</div>
          <div className={`md-profile__career-value ${career.winPct >= 60 ? 'md-profile__career-value--good' : ''}`}>
            {career.winPct}%
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- Sidebar cards ----------------------------------------------- */

function MatchInfoCard({ context, format, state }: { context: Context; format: Format; state: MatchState }) {
  const rows: Array<[string, string]> = []
  if (context !== 'casual') {
    rows.push(['Tournament', MATCH.tournament])
    rows.push(['Round', MATCH.round])
    rows.push(['Match', `#${MATCH.matchNo}`])
  } else {
    rows.push(['Venue', 'Saigon TT — Hall B'])
    rows.push(['League', 'Club night · Tue'])
  }
  rows.push(['Format', `${format === 'doubles' ? 'Doubles' : 'Singles'} · Best of 5 to 11`])
  rows.push(['Court', MATCH.court])
  rows.push(['Date', MATCH.date])
  rows.push(['Started', state === 'upcoming' ? '—' : MATCH.startedAt])
  if (state !== 'upcoming') rows.push(['Duration', MATCH.duration])
  if (context !== 'casual') {
    rows.push(['Referee', MATCH.referee])
    rows.push(['Umpire', MATCH.umpire])
  }
  if (state !== 'upcoming') rows.push(['Spectators', `${MATCH.spectators}`])

  return (
    <div className="md-card">
      <div className="md-card__hd"><h3>Match info</h3></div>
      <div className="md-card__body">
        {rows.map(([k, v], i) => (
          <div key={i} className="md-info-row">
            <span className="md-info-row__k">{k}</span>
            <span className="md-info-row__v">{v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function RatingCard({ format, state, context }: { format: Format; state: MatchState; context: Context }) {
  if (context === 'casual') {
    return (
      <div className="md-card">
        <div className="md-card__hd"><h3>Club rating</h3></div>
        <div className="md-card__body">
          <div style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-3)', lineHeight: 1.5 }}>
            Club nights don't affect official ratings — but we still track the wins.
          </div>
        </div>
      </div>
    )
  }
  const players = format === 'doubles' ? DOUBLES_PLAYERS : SINGLES_PLAYERS
  if (state === 'upcoming') {
    return (
      <div className="md-card">
        <div className="md-card__hd"><h3>At stake</h3></div>
        <div className="md-card__body">
          <div style={{ font: '500 13px var(--font-ui)', color: 'var(--fg-2)', lineHeight: 1.5 }}>
            Projected swing:{' '}
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--ball-500)', fontWeight: 700 }}>±11 pts</span>{' '}
            for the winner.
            <br />
            Winner advances to{' '}
            <span style={{ color: 'var(--fg-1)', fontWeight: 600 }}>QF · Match #5</span>.
          </div>
        </div>
      </div>
    )
  }
  const isDoubles = format === 'doubles'
  return (
    <div className="md-card">
      <div className="md-card__hd"><h3>Rating change</h3></div>
      <div className="md-card__body" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <RatingRow p={players.a} win doubles={isDoubles} />
        <hr className="md-rating-divider" />
        <RatingRow p={players.b} win={false} doubles={isDoubles} />
      </div>
    </div>
  )
}

function RatingRow({ p, win, doubles }: { p: SinglesPlayer | DoublesPlayer; win: boolean; doubles: boolean }) {
  if (doubles) {
    const dp = p as DoublesPlayer
    return (
      <div className="md-rating-row">
        <div className={`md-avatar ${win ? 'md-avatar--win' : 'md-avatar--loss'}`} style={{ width: 36, height: 36, fontSize: 12 }}>
          {dp.initials}
        </div>
        <div className="md-rating-row__text">
          <div className="md-rating-row__name">{dp.last}</div>
          <div style={{ font: '500 11px var(--font-mono)', color: 'var(--fg-3)', letterSpacing: '0.06em', marginTop: 2 }}>
            {dp.rating}
          </div>
        </div>
        <div className={`md-rating-row__delta-num ${dp.delta > 0 ? 'md-delta-up' : 'md-delta-down'}`}>
          {dp.ratingNew}
        </div>
      </div>
    )
  }

  const isA = p.id === 'a'
  const history = isA ? [2098, 2110, 2128, 2120, 2145, 2157] : [2080, 2065, 2050, 2018, 2002, 1990]
  const rating = isA ? 2145 : 2002
  const ratingNew = isA ? 2157 : 1990
  const delta = isA ? 12 : -12
  const sp = p as SinglesPlayer

  return (
    <div className="md-rating-row">
      <div className={`md-avatar ${win ? 'md-avatar--win' : 'md-avatar--loss'}`}>
        {sp.initials}
      </div>
      <div className="md-rating-row__text">
        <div className="md-rating-row__name">{sp.last}, {sp.first}</div>
        <div className="md-rating-row__numbers">
          <span className="from">{rating}</span>
          <ChevronRight size={11} strokeWidth={1.75} />
          <span className="to">{ratingNew}</span>
        </div>
      </div>
      <div className="md-rating-row__delta">
        <Sparkline points={history} color={delta > 0 ? 'var(--serve-500)' : 'var(--loss)'} width={60} height={24} />
        <span className={`md-rating-row__delta-num ${delta > 0 ? 'md-delta-up' : 'md-delta-down'}`}>
          {delta > 0 ? '+' : ''}{delta}
        </span>
      </div>
    </div>
  )
}

function H2HCard({ format }: { format: Format }) {
  const a = H2H.aWins
  const b = H2H.bWins
  const tot = H2H.total
  const aPct = (a / tot) * 100
  const bPct = (b / tot) * 100

  return (
    <div className="md-card">
      <div className="md-card__hd">
        <h3>Head to head</h3>
        <span style={{ font: '500 11px var(--font-mono)', color: 'var(--fg-3)', letterSpacing: '0.12em' }}>
          {tot} MEETINGS
        </span>
      </div>
      <div className="md-card__body">
        <div className="md-h2h">
          <div className="md-h2h__counts">
            <div style={{ textAlign: 'right' }}>
              <div className="md-h2h__count md-h2h__count--win">{a}</div>
              <div className="md-h2h__count-label">{format === 'doubles' ? 'NP' : 'Nguyen'}</div>
            </div>
            <span className="md-h2h__sep">—</span>
            <div style={{ textAlign: 'left' }}>
              <div className="md-h2h__count">{b}</div>
              <div className="md-h2h__count-label">{format === 'doubles' ? 'OT' : 'Okafor'}</div>
            </div>
          </div>
          <div className="md-h2h__bar">
            <div style={{ width: `${aPct}%`, background: 'var(--serve-500)' }} />
            <div style={{ width: `${bPct}%`, background: 'var(--ink-500)' }} />
          </div>
          <div>
            {H2H.matches.slice(0, 5).map((m) => (
              <div key={m.id} className="md-h2h__row">
                <span className="md-h2h__date">{m.date.slice(2).replace(/-/g, '·')}</span>
                <span className={`md-h2h__label ${m.tonight ? 'md-h2h__label--tonight' : ''}`}>
                  {m.tonight ? '● Tonight' : m.round}
                </span>
                <span className={`md-h2h__score ${m.winner === 'a' ? 'md-h2h__score--win' : ''}`}>
                  {m.score[0]}–{m.score[1]}
                </span>
                <span className={`md-h2h__result md-h2h__result--${m.winner === 'a' ? 'w' : 'l'}`}>
                  {m.winner === 'a' ? 'W' : 'L'}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ---------- Comments ---------------------------------------------------- */

function CommentsCard({ state }: { state: MatchState }) {
  const [list, setList] = useState<Comment[]>(COMMENTS_INIT)
  const [draft, setDraft] = useState('')

  function toggleReact(idx: number, k: 'ball' | 'fire') {
    setList((prev) =>
      prev.map((c, i) => {
        if (i !== idx) return c
        const has = c.yours[k]
        return {
          ...c,
          yours: { ...c.yours, [k]: !has },
          reacts: { ...c.reacts, [k]: c.reacts[k] + (has ? -1 : 1) },
        }
      }),
    )
  }

  function submit(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setList((prev) => [
      { who: 'You', initials: 'YO', when: 'just now', body: text, reacts: { ball: 0, fire: 0 }, yours: { ball: false, fire: false } },
      ...prev,
    ])
    setDraft('')
  }

  return (
    <div className="md-card">
      <div className="md-card__hd">
        <h3>Club chat</h3>
        <span style={{ font: '500 11px var(--font-mono)', color: 'var(--fg-3)', letterSpacing: '0.12em' }}>
          {list.length} POSTS
        </span>
      </div>
      <div className="md-card__body">
        <form className="md-comments__form" onSubmit={submit}>
          <div className="md-avatar">YO</div>
          <input
            type="text"
            className="md-input"
            placeholder={state === 'upcoming' ? 'Place a pick. Trash talk. Kindly.' : 'Add a reaction…'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button
            type="submit"
            className="md-btn md-btn--primary md-btn--sm"
            disabled={!draft.trim()}
            style={{ opacity: draft.trim() ? 1 : 0.45 }}
          >
            Post
          </button>
        </form>
        <div>
          {list.map((c, i) => (
            <div key={i} className="md-comment">
              <div className="md-avatar">{c.initials}</div>
              <div>
                <div className="md-comment__meta">
                  <span className="md-comment__who">{c.who}</span>
                  <span className="md-comment__when">· {c.when}</span>
                </div>
                <div className="md-comment__body">{c.body}</div>
                <div className="md-comment__reacts">
                  <button type="button" className={`md-react ${c.yours.ball ? 'is-on' : ''}`} onClick={() => toggleReact(i, 'ball')}>
                    <span className="md-react__glyph">●</span> {c.reacts.ball}
                  </button>
                  <button type="button" className={`md-react ${c.yours.fire ? 'is-on' : ''}`} onClick={() => toggleReact(i, 'fire')}>
                    <span className="md-react__glyph">★</span> {c.reacts.fire}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ---------- Share modal -------------------------------------------------- */

function ShareModal({
  open,
  onClose,
  state,
  format,
}: {
  open: boolean
  onClose: () => void
  state: MatchState
  format: Format
}) {
  const [copied, setCopied] = useState(false)
  const url = `https://fortymm.app/m/spring-open-2026/r16/14${format === 'doubles' ? '-d' : ''}`

  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = url
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2200)
  }

  const summary =
    state === 'final'
      ? format === 'doubles'
        ? 'Final · 3–2 · Nguyen/Patel def. Okafor/Tanaka'
        : 'Final · 3–1 · Nguyen def. Okafor'
      : state === 'live'
        ? format === 'doubles'
          ? 'Live · 2–1 · G4 · Nguyen/Patel vs Okafor/Tanaka'
          : 'Live · 2–1 · G4 · Nguyen vs Okafor'
        : format === 'doubles'
          ? 'Upcoming · Nguyen/Patel vs Okafor/Tanaka'
          : 'Upcoming · Nguyen vs Okafor'

  return (
    <div className="md-modal-scrim" onClick={onClose}>
      <div className="md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="md-modal__hd">
          <div>
            <div className="md-kicker">● Share match</div>
            <div className="md-modal__title" style={{ marginTop: 4 }}>One link. Anyone can view.</div>
          </div>
          <button type="button" className="md-btn md-btn--ghost md-btn--icon md-btn--sm" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div className="md-modal__body">
          <div className="md-modal__preview">
            <div className="md-avatar md-avatar--win">TN</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="md-modal__preview-title">
                {format === 'doubles' ? 'Nguyen/Patel vs Okafor/Tanaka' : 'Nguyen, T. vs Okafor, D.'}
              </div>
              <div className="md-modal__preview-sub">{summary}</div>
            </div>
          </div>

          <div className="md-modal__url-row">
            <div className="md-modal__url">{url}</div>
            <button type="button" className="md-btn md-btn--primary" onClick={copy}>
              {copied ? (
                <><Check size={14} /> Copied</>
              ) : (
                <><Copy size={14} /> Copy</>
              )}
            </button>
          </div>

          <div className="md-modal__tiles">
            <ShareTile icon={<Send size={16} />} label="Post on X" hint="@spring_open" />
            <ShareTile icon={<Link2 size={16} />} label="Embed" hint="iframe" />
            <ShareTile icon={<Download size={16} />} label="Save PNG" hint="Recap card" />
          </div>

          <div className="md-modal__note">
            <span className="accent">●</span>
            <div>
              Public links don't require a FortyMM account. We never track who clicks them — share the URL like it's 2004.
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function ShareTile({ icon, label, hint }: { icon: React.ReactNode; label: string; hint: string }) {
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

/* ---------- Page --------------------------------------------------------- */

function MatchDetailsPage() {
  // Variant state is preserved so the components can render any of
  // live/final/upcoming, singles/doubles, or tournament/casual — but the
  // demo toggles that switched between them have been removed for now.
  const [state, _setState] = useState<MatchState>('final')
  const [format, _setFormat] = useState<Format>('singles')
  const [context, _setContext] = useState<Context>('tournament')
  const [shareOpen, setShareOpen] = useState(false)

  return (
    <AppShell>
      <div className="match-details">
        <main className="md-page" style={{ padding: '32px 32px 80px' }}>
          <div className="md-header">
            <Breadcrumb context={context} />
            <div className="md-header__right">
              <button type="button" className="md-btn md-btn--ghost md-btn--sm" onClick={() => setShareOpen(true)}>
                <Share2 size={14} /> Share
              </button>
            </div>
          </div>

          <div key={`hero-${state}-${format}-${context}`} className="md-fade-swap">
            <HeroScoreboard state={state} format={format} context={context} />
          </div>

          <div className="md-col-2">
            <div className="md-col-2__main" key={`main-${state}-${format}`}>
              <PlayersCard state={state} format={format} />
              <CommentsCard state={state} />
            </div>
            <aside className="md-col-2__aside">
              <MatchInfoCard context={context} format={format} state={state} />
              <RatingCard format={format} state={state} context={context} />
              <H2HCard format={format} />
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

        <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} state={state} format={format} />
      </div>
    </AppShell>
  )
}

