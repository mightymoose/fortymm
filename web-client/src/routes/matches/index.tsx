import { Fragment, useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Inbox,
  MoreHorizontal,
  Search,
} from 'lucide-react'

import { AppShell } from '@/components/app-shell'
import './index.css'

export const Route = createFileRoute('/matches/')({
  component: MatchesPage,
})

type ContextKey = 'tournament' | 'club' | 'casual' | 'ladder'
type StatusKey = 'live' | 'final' | 'called' | 'scheduled'
type Winner = 'a' | 'b' | null
type Player = { name: string; seed: number }

interface Match {
  id: number
  context: ContextKey
  contextLabel: string
  round: string | null
  roundOrder: number
  court: number | null
  a: Player
  b: Player
  status: StatusKey
  games: [number, number][]
  aGames: number
  bGames: number
  winner: Winner
  time: Date
  bestOf: number
}

const PLAYERS: [string, number][] = [
  ['Nguyen, T.', 1], ['Silva, R.', 2], ['Okafor, D.', 3], ['Johansen, A.', 4],
  ['Tran, L.', 5], ['Patel, M.', 6], ['Chen, W.', 7], ['Park, J.', 8],
  ['Kim, H.', 9], ['Ali, R.', 10], ['Rossi, G.', 11], ['Dubois, C.', 12],
  ['Garcia, P.', 13], ['Müller, F.', 14], ['Tanaka, K.', 15], ['Yamamoto, S.', 16],
  ['Ahmadi, B.', 17], ['Schmidt, L.', 18], ['Ivanova, N.', 19], ['Petrov, M.', 20],
  ['Hassan, Y.', 21], ['O’Brien, P.', 22], ['Andersson, E.', 23], ['Lopez, R.', 24],
  ['Becker, T.', 25], ['Cohen, D.', 26], ['Fernandez, J.', 27], ['Gupta, A.', 28],
  ['Holm, V.', 29], ['Iwasaki, R.', 30], ['Jansen, K.', 31], ['Khan, S.', 32],
  ['Lee, M.', 33], ['Moreau, A.', 34], ['Novak, J.', 35], ['Owens, B.', 36],
  ['Pham, Q.', 37], ['Quinn, R.', 38], ['Reyes, T.', 39], ['Sato, H.', 40],
  ['Torres, M.', 41], ['Ueda, K.', 42], ['Vargas, P.', 43], ['Wang, X.', 44],
  ['Xu, L.', 45], ['Yusupov, F.', 46], ['Zhao, M.', 47], ['Abbas, N.', 48],
  ['Brun, T.', 49], ['Costa, E.', 50], ['Diallo, S.', 51], ['Eriksen, J.', 52],
  ['Fischer, M.', 53], ['Gomez, H.', 54], ['Hartmann, P.', 55], ['Inoue, R.', 56],
  ['Jakobsen, A.', 57], ['Klein, S.', 58], ['Lindgren, O.', 59], ['Mancini, G.', 60],
  ['Nakamura, T.', 61], ['Olsen, K.', 62], ['Pavlov, D.', 63], ['Rahman, M.', 64],
]

const AVATAR_PALETTE: [string, string][] = [
  ['#3A4152', '#E4E7EF'], ['#1F2430', '#FFCFA8'], ['#171B24', '#8CFFD4'],
  ['#11141B', '#FF9A4A'], ['#2A3040', '#A9B0C2'], ['#1F2430', '#6FB5FF'],
]

function avatarColors(seed: number): [string, string] {
  return AVATAR_PALETTE[(seed - 1) % AVATAR_PALETTE.length]
}

function initials(name: string): string {
  const [last, first] = name.split(',').map((s) => s.trim())
  return ((first || '')[0] || '') + (last[0] || '')
}

const CONTEXTS: Record<ContextKey, { label: string; short: string }> = {
  tournament: { label: 'Tournament', short: 'Tournament' },
  club: { label: 'Club night', short: 'Club' },
  casual: { label: 'Casual', short: 'Casual' },
  ladder: { label: 'Ladder', short: 'Ladder' },
}

const TOURNAMENTS = ['Spring Open', 'City Cup', 'River League']
const CLUBS = ['Riverside TT', 'East Side Pong', 'Downtown Paddle']

const MOCK_TODAY_MS = new Date('2026-05-16T00:00:00').getTime()

const ROUND_DEFS = [
  { code: 'R64', label: 'Round of 64', order: 1 },
  { code: 'R32', label: 'Round of 32', order: 2 },
  { code: 'R16', label: 'Round of 16', order: 3 },
  { code: 'QF', label: 'Quarterfinal', order: 4 },
  { code: 'SF', label: 'Semifinal', order: 5 },
  { code: 'F', label: 'Final', order: 6 },
] as const

function buildMatches(): Match[] {
  let s = 17
  const rnd = () => (s = (s * 9301 + 49297) % 233280) / 233280
  const pickPlayers = (): [[string, number], [string, number]] => {
    const aIdx = Math.floor(rnd() * PLAYERS.length)
    let bIdx = Math.floor(rnd() * PLAYERS.length)
    while (bIdx === aIdx) bIdx = Math.floor(rnd() * PLAYERS.length)
    return [PLAYERS[aIdx], PLAYERS[bIdx]]
  }

  const start = new Date('2026-05-16T09:00:00')
  const out: Match[] = []
  let id = 1001

  const tName = TOURNAMENTS[0]
  ROUND_DEFS.forEach((r) => {
    const counts: Record<string, number> = {
      R64: 16, R32: 10, R16: 8, QF: 4, SF: 2, F: 1,
    }
    const n = counts[r.code]
    for (let i = 0; i < n; i++) {
      const [a, b] = pickPlayers()
      const minute = (r.order - 1) * 110 + i * 16 + Math.floor(rnd() * 6)
      const when = new Date(start.getTime() + minute * 60000)
      let status: StatusKey
      if (r.order <= 2) status = 'final'
      else if (r.order === 3)
        status = rnd() < 0.7 ? 'final' : rnd() < 0.5 ? 'live' : 'called'
      else if (r.order === 4)
        status = rnd() < 0.4 ? 'final' : rnd() < 0.55 ? 'live' : 'scheduled'
      else status = rnd() < 0.5 ? 'scheduled' : 'called'
      out.push(
        buildMatch({
          id: id++, rnd,
          context: 'tournament', contextLabel: tName,
          round: r.code, roundOrder: r.order,
          court: 1 + Math.floor(rnd() * 8),
          a, b, status, time: when, bestOf: 7,
        }),
      )
    }
  })

  for (let i = 0; i < 14; i++) {
    const [a, b] = pickPlayers()
    const dayOffset = (i % 3) - 2
    const evening = new Date(
      start.getTime() +
        dayOffset * 86400000 +
        (12 * 60 + Math.floor(rnd() * 180)) * 60000,
    )
    const status: StatusKey = i < 2 ? 'live' : 'final'
    out.push(
      buildMatch({
        id: id++, rnd,
        context: 'club', contextLabel: CLUBS[i % CLUBS.length],
        round: null, roundOrder: 0,
        court: 1 + Math.floor(rnd() * 4),
        a, b, status, time: evening, bestOf: 5,
      }),
    )
  }

  for (let i = 0; i < 16; i++) {
    const [a, b] = pickPlayers()
    const dayOffset = -Math.floor(rnd() * 7)
    const when = new Date(
      start.getTime() + dayOffset * 86400000 + Math.floor(rnd() * 720) * 60000,
    )
    out.push(
      buildMatch({
        id: id++, rnd,
        context: 'casual', contextLabel: 'Casual',
        round: null, roundOrder: 0, court: null,
        a, b, status: 'final', time: when, bestOf: 3,
      }),
    )
  }

  for (let i = 0; i < 8; i++) {
    const [a, b] = pickPlayers()
    const dayOffset = -Math.floor(rnd() * 14)
    const when = new Date(
      start.getTime() + dayOffset * 86400000 + Math.floor(rnd() * 720) * 60000,
    )
    const status: StatusKey = i === 0 ? 'scheduled' : 'final'
    out.push(
      buildMatch({
        id: id++, rnd,
        context: 'ladder', contextLabel: 'Club ladder',
        round: null, roundOrder: 0, court: null,
        a, b, status, time: when, bestOf: 5,
      }),
    )
  }

  return out
}

interface BuildMatchInput {
  id: number
  rnd: () => number
  context: ContextKey
  contextLabel: string
  round: string | null
  roundOrder: number
  court: number | null
  a: [string, number]
  b: [string, number]
  status: StatusKey
  time: Date
  bestOf: number
}

function buildMatch(input: BuildMatchInput): Match {
  const { id, rnd, context, contextLabel, round, roundOrder, court, a, b, status, time, bestOf } = input
  const target = Math.ceil(bestOf / 2)
  const games: [number, number][] = []
  let aGames = 0
  let bGames = 0
  if (status === 'final') {
    const aWins = rnd() < 0.55
    while (aGames < target && bGames < target) {
      if (rnd() < (aWins ? 0.6 : 0.4)) aGames++
      else bGames++
    }
    const total = aGames + bGames
    for (let g = 0; g < total; g++) {
      const aIsGameWinner = rnd() < (aWins ? 0.6 : 0.4)
      const winnerScore = 11 + Math.floor(rnd() * 3)
      const loserScore = Math.max(0, winnerScore - 2 - Math.floor(rnd() * 8))
      games.push(aIsGameWinner ? [winnerScore, loserScore] : [loserScore, winnerScore])
    }
  } else if (status === 'live') {
    const done = Math.min(target - 1, 1 + Math.floor(rnd() * (target - 1)))
    for (let g = 0; g < done; g++) {
      const aIsGameWinner = rnd() < 0.5
      const winnerScore = 11 + Math.floor(rnd() * 3)
      const loserScore = Math.max(0, winnerScore - 2 - Math.floor(rnd() * 8))
      games.push(aIsGameWinner ? [winnerScore, loserScore] : [loserScore, winnerScore])
      if (aIsGameWinner) aGames++
      else bGames++
    }
    games.push([Math.floor(rnd() * 11), Math.floor(rnd() * 11)])
  }
  const winner: Winner = status === 'final' ? (aGames > bGames ? 'a' : 'b') : null
  return {
    id, context, contextLabel, round, roundOrder, court,
    a: { name: a[0], seed: a[1] },
    b: { name: b[0], seed: b[1] },
    status, games, aGames, bGames, winner, time, bestOf,
  }
}

interface Counts {
  total: number
  live: number
  called: number
  scheduled: number
  final: number
}

function ActionBar({ liveCount }: { liveCount: number }) {
  return (
    <div className="action-bar">
      <div className="action-bar-title">Matches</div>
      <div className="action-bar-crumb">Across tournaments, club nights, ladder &amp; casual</div>
      <span className="live-pill">
        <span className="live-dot" />
        {String(liveCount).padStart(2, '0')} LIVE
      </span>
      <div className="filter-spacer" />
      <button type="button" className="ml-btn ghost">Export CSV</button>
      <button type="button" className="ml-btn primary">+ New match</button>
    </div>
  )
}

interface StatusTabProps {
  value: 'all' | StatusKey
  label: string
  count: number
  current: string
  onClick: (v: 'all' | StatusKey) => void
  live?: boolean
}

function StatusTab({ value, label, count, current, onClick, live }: StatusTabProps) {
  return (
    <button
      type="button"
      className={'seg-btn' + (current === value ? ' is-active' : '')}
      onClick={() => onClick(value)}
    >
      {live && <span className="live-dot" />}
      {label}
      <span className="seg-count">{count}</span>
    </button>
  )
}

interface FilterRowProps {
  q: string
  setQ: (v: string) => void
  status: 'all' | StatusKey
  setStatus: (v: 'all' | StatusKey) => void
  context: 'all' | ContextKey
  setContext: (v: 'all' | ContextKey) => void
  round: string
  setRound: (v: string) => void
  court: string
  setCourt: (v: string) => void
  counts: Counts
  courtOptions: number[]
  onClear: () => void
  anyFilter: boolean
}

function FilterRow(props: FilterRowProps) {
  const {
    q, setQ, status, setStatus, context, setContext, round, setRound, court, setCourt,
    counts, courtOptions, onClear, anyFilter,
  } = props
  return (
    <div className="filter-row">
      <div className="ml-search">
        <span className="ml-search-icon"><Search size={16} strokeWidth={2} /></span>
        <input
          placeholder="Search players or match #…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {q && (
          <button type="button" className="ml-search-clear" onClick={() => setQ('')} aria-label="Clear search">
            ×
          </button>
        )}
      </div>

      <div className="seg" role="tablist">
        <StatusTab value="all" label="All" count={counts.total} current={status} onClick={setStatus} />
        <StatusTab value="live" label="Live" count={counts.live} current={status} onClick={setStatus} live />
        <StatusTab value="called" label="Called" count={counts.called} current={status} onClick={setStatus} />
        <StatusTab value="scheduled" label="Up next" count={counts.scheduled} current={status} onClick={setStatus} />
        <StatusTab value="final" label="Final" count={counts.final} current={status} onClick={setStatus} />
      </div>

      <div className="filter-spacer" />

      <span className="filter-label">Context</span>
      <div className="select-wrap">
        <select
          className="ml-select"
          value={context}
          onChange={(e) => setContext(e.target.value as 'all' | ContextKey)}
        >
          <option value="all">All contexts</option>
          {(Object.entries(CONTEXTS) as [ContextKey, { label: string }][]).map(([k, v]) => (
            <option key={k} value={k}>{v.label}</option>
          ))}
        </select>
        <span className="select-caret"><ChevronDown size={12} strokeWidth={2.4} /></span>
      </div>

      <span className="filter-label">Round</span>
      <div className="select-wrap">
        <select className="ml-select" value={round} onChange={(e) => setRound(e.target.value)}>
          <option value="all">All rounds</option>
          {ROUND_DEFS.map((r) => (
            <option key={r.code} value={r.code}>{r.label}</option>
          ))}
        </select>
        <span className="select-caret"><ChevronDown size={12} strokeWidth={2.4} /></span>
      </div>

      <span className="filter-label">Court</span>
      <div className="select-wrap">
        <select className="ml-select" value={court} onChange={(e) => setCourt(e.target.value)}>
          <option value="all">All courts</option>
          {courtOptions.map((c) => (
            <option key={c} value={String(c)}>Court {c}</option>
          ))}
        </select>
        <span className="select-caret"><ChevronDown size={12} strokeWidth={2.4} /></span>
      </div>

      {anyFilter && (
        <button type="button" className="ml-btn ghost" onClick={onClear}>Clear filters</button>
      )}
    </div>
  )
}

function Avatar({ name, seed }: { name: string; seed: number }) {
  const [bg, fg] = avatarColors(seed)
  return (
    <span className="ml-avatar" style={{ background: bg, color: fg }}>
      {initials(name)}
    </span>
  )
}

function ContextCell({ m }: { m: Match }) {
  return (
    <div className={'ctx-chip ctx-' + m.context}>
      <span className="ctx-dot" />
      <div>
        <div>{CONTEXTS[m.context].short}</div>
        <div className="ctx-meta">{m.contextLabel}</div>
      </div>
    </div>
  )
}

function PlayerCell({ a, b, winner, status }: { a: Player; b: Player; winner: Winner; status: StatusKey }) {
  const aClass =
    'player-name' + (status === 'final' ? (winner === 'a' ? ' is-winner' : ' is-loser') : '')
  const bClass =
    'player-name' + (status === 'final' ? (winner === 'b' ? ' is-winner' : ' is-loser') : '')
  return (
    <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
      <div className="player">
        <Avatar name={a.name} seed={a.seed} />
        <span className={aClass}>{a.name}</span>
        <span className="seed-tag">#{a.seed}</span>
      </div>
      <span className="vs">vs</span>
      <div className="player">
        <Avatar name={b.name} seed={b.seed} />
        <span className={bClass}>{b.name}</span>
        <span className="seed-tag">#{b.seed}</span>
      </div>
    </div>
  )
}

function ScoreCell({ m }: { m: Match }) {
  if (m.status === 'scheduled' || m.status === 'called') {
    return <span className="score-cell pending">—</span>
  }
  if (m.status === 'live') {
    const last = m.games[m.games.length - 1]
    return (
      <span className="score-cell">
        <span className="games">{m.aGames}–{m.bGames}</span>
        {last && (
          <span className="score-meta">({last[0]}–{last[1]})</span>
        )}
      </span>
    )
  }
  const winnerIdx = m.winner === 'a' ? 0 : 1
  return (
    <span className="score-cell games">
      {m.games.map((g, i) => {
        const lost = g[winnerIdx] < g[1 - winnerIdx]
        return (
          <Fragment key={i}>
            <span className={lost ? 'lost' : ''}>{g[0]}–{g[1]}</span>
            {i < m.games.length - 1 && <span className="score-sep">·</span>}
          </Fragment>
        )
      })}
    </span>
  )
}

function StatusBadge({ status }: { status: StatusKey }) {
  if (status === 'live')
    return (
      <span className="status is-live">
        <span className="live-dot" />Live
      </span>
    )
  if (status === 'final') return <span className="status is-final">Final</span>
  if (status === 'called') return <span className="status is-called">Called</span>
  return <span className="status is-scheduled">Scheduled</span>
}

function TimeCell({ t }: { t: Date }) {
  const hh = String(t.getHours()).padStart(2, '0')
  const mm = String(t.getMinutes()).padStart(2, '0')
  const dayMs = new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()
  const diffDays = Math.round((MOCK_TODAY_MS - dayMs) / 86400000)
  let when: string
  if (diffDays === 0) when = `${hh}:${mm}`
  else if (diffDays === 1) when = `yest ${hh}:${mm}`
  else if (diffDays > 1) when = `${diffDays}d ago`
  else when = `+${-diffDays}d`
  return (
    <span className="time-cell">
      <span className="strong">{when}</span>
    </span>
  )
}

type SortKey = 'id' | 'context' | 'round' | 'court' | 'score' | 'status' | 'time'
type SortState = { key: SortKey; dir: 'asc' | 'desc' }

interface SortHeaderProps {
  id: SortKey
  label: string
  sort: SortState
  setSort: (v: SortState) => void
  width?: number
}

function SortHeader({ id, label, sort, setSort, width }: SortHeaderProps) {
  const isSorted = sort.key === id
  const dir = isSorted ? sort.dir : null
  return (
    <th
      className={'sortable' + (isSorted ? ' is-sorted' : '')}
      onClick={() =>
        setSort(
          sort.key === id
            ? { key: id, dir: sort.dir === 'asc' ? 'desc' : 'asc' }
            : { key: id, dir: 'asc' },
        )
      }
      style={{ width }}
    >
      {label}
      <span className="sort-arrow">{dir === 'asc' ? '↑' : '↓'}</span>
    </th>
  )
}

function SkeletonRow() {
  return (
    <tr className="skeleton-row">
      <td><span className="skeleton s-text-sm" style={{ width: 50 }} /></td>
      <td><span className="skeleton s-chip" style={{ width: 84, height: 30, borderRadius: 6 }} /></td>
      <td><span className="skeleton s-chip" /></td>
      <td><span className="skeleton s-text-sm" style={{ width: 40 }} /></td>
      <td>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span className="skeleton s-avatar" />
          <span className="skeleton s-text-md" />
          <span style={{ width: 24, display: 'inline-block' }} />
          <span className="skeleton s-avatar" />
          <span className="skeleton s-text-md" />
        </span>
      </td>
      <td><span className="skeleton s-text-lg" /></td>
      <td><span className="skeleton s-chip" style={{ width: 64 }} /></td>
      <td><span className="skeleton s-text-sm" /></td>
      <td />
    </tr>
  )
}

interface MatchTableProps {
  rows: Match[]
  sort: SortState
  setSort: (v: SortState) => void
  onClear: () => void
  loading: boolean
  pageSize: number
}

function MatchTable({ rows, sort, setSort, onClear, loading, pageSize }: MatchTableProps) {
  if (loading) {
    return (
      <table className="matches">
        <thead>
          <tr>
            <th style={{ width: 84 }}>#</th>
            <th style={{ width: 130 }}>Context</th>
            <th style={{ width: 90 }}>Round</th>
            <th style={{ width: 70 }}>Court</th>
            <th>Players</th>
            <th style={{ width: 220 }}>Score</th>
            <th style={{ width: 120 }}>Status</th>
            <th style={{ width: 100 }}>Time</th>
            <th style={{ width: 36 }} />
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: Math.min(pageSize, 10) }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </tbody>
      </table>
    )
  }
  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-icon"><Inbox size={56} strokeWidth={1.5} /></div>
        <div className="empty-title">No matches match these filters</div>
        <div className="empty-sub">Try widening the context, round, or court — or clear the search.</div>
        <button type="button" className="ml-btn ghost empty-clear" onClick={onClear}>Clear filters</button>
      </div>
    )
  }
  return (
    <table className="matches">
      <thead>
        <tr>
          <SortHeader id="id" label="#" sort={sort} setSort={setSort} width={84} />
          <SortHeader id="context" label="Context" sort={sort} setSort={setSort} width={130} />
          <SortHeader id="round" label="Round" sort={sort} setSort={setSort} width={90} />
          <SortHeader id="court" label="Court" sort={sort} setSort={setSort} width={70} />
          <th>Players</th>
          <SortHeader id="score" label="Score" sort={sort} setSort={setSort} width={220} />
          <SortHeader id="status" label="Status" sort={sort} setSort={setSort} width={120} />
          <SortHeader id="time" label="Time" sort={sort} setSort={setSort} width={100} />
          <th style={{ width: 36 }} />
        </tr>
      </thead>
      <tbody>
        {rows.map((m) => (
          <tr key={m.id} className={m.status === 'live' ? 'is-live' : ''}>
            <td className="id-cell">M-{m.id}</td>
            <td><ContextCell m={m} /></td>
            <td>
              {m.round ? (
                <span className={'round-chip' + (m.round === 'F' || m.round === 'SF' ? ' is-final' : '')}>
                  {m.round}
                </span>
              ) : (
                <span className="cell-na">—</span>
              )}
            </td>
            <td className="court-cell">
              {m.court != null ? `C${m.court}` : <span className="cell-na">—</span>}
            </td>
            <td><PlayerCell a={m.a} b={m.b} winner={m.winner} status={m.status} /></td>
            <td><ScoreCell m={m} /></td>
            <td><StatusBadge status={m.status} /></td>
            <td><TimeCell t={m.time} /></td>
            <td>
              <button
                type="button"
                className="row-action"
                onClick={(e) => e.stopPropagation()}
                aria-label="Row actions"
              >
                <MoreHorizontal size={16} strokeWidth={2} />
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function paginationRange(current: number, total: number): (number | 'ell-l' | 'ell-r')[] {
  const delta = 1
  const range: (number | 'ell-l' | 'ell-r')[] = []
  const left = Math.max(2, current - delta)
  const right = Math.min(total - 1, current + delta)
  range.push(1)
  if (left > 2) range.push('ell-l')
  for (let i = left; i <= right; i++) range.push(i)
  if (right < total - 1) range.push('ell-r')
  if (total > 1) range.push(total)
  return range
}

interface PaginationProps {
  page: number
  setPage: (n: number) => void
  total: number
  pageSize: number
  setPageSize: (n: number) => void
  filteredCount: number
  disabled: boolean
}

function PaginationFooter(props: PaginationProps) {
  const { page, setPage, total, pageSize, setPageSize, filteredCount, disabled } = props
  const first = filteredCount === 0 ? 0 : (page - 1) * pageSize + 1
  const last = Math.min(filteredCount, page * pageSize)
  const tokens = paginationRange(page, total || 1)

  return (
    <div className="footer">
      <div className="footer-info">
        Showing <span className="mono">{first}–{last}</span> of{' '}
        <span className="mono">{filteredCount}</span> matches
      </div>
      <div className="footer-spacer" />
      <div className="page-size">
        Rows per page
        <div className="select-wrap">
          <select
            className="ml-select"
            style={{ minWidth: 0, height: 32, padding: '0 28px 0 10px' }}
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value))
              setPage(1)
            }}
          >
            {[10, 15, 25, 50].map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
          <span className="select-caret"><ChevronDown size={12} strokeWidth={2.4} /></span>
        </div>
      </div>
      <div className="pagination">
        <button
          type="button"
          className="page-btn is-nav"
          disabled={disabled || page <= 1}
          onClick={() => setPage(1)}
          aria-label="First page"
        >
          <ChevronsLeft size={14} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          className="page-btn is-nav"
          disabled={disabled || page <= 1}
          onClick={() => setPage(page - 1)}
          aria-label="Previous"
        >
          <ChevronLeft size={14} strokeWidth={2.4} />
        </button>
        {tokens.map((t, i) =>
          typeof t === 'number' ? (
            <button
              key={i}
              type="button"
              disabled={disabled}
              className={'page-btn' + (t === page ? ' is-current' : '')}
              onClick={() => setPage(t)}
            >
              {t}
            </button>
          ) : (
            <span key={i} className="page-btn is-ellipsis">…</span>
          ),
        )}
        <button
          type="button"
          className="page-btn is-nav"
          disabled={disabled || page >= total}
          onClick={() => setPage(page + 1)}
          aria-label="Next"
        >
          <ChevronRight size={14} strokeWidth={2.4} />
        </button>
        <button
          type="button"
          className="page-btn is-nav"
          disabled={disabled || page >= total}
          onClick={() => setPage(total)}
          aria-label="Last page"
        >
          <ChevronsRight size={14} strokeWidth={2.4} />
        </button>
      </div>
    </div>
  )
}

const ALL_MATCHES = buildMatches()

const STATUS_ORDER: Record<StatusKey, number> = { live: 0, called: 1, scheduled: 2, final: 3 }
const CONTEXT_ORDER: Record<ContextKey, number> = { tournament: 0, club: 1, ladder: 2, casual: 3 }

const COUNTS: Counts = (() => {
  const out: Counts = { total: ALL_MATCHES.length, live: 0, called: 0, scheduled: 0, final: 0 }
  ALL_MATCHES.forEach((m) => {
    out[m.status]++
  })
  return out
})()

const COURT_OPTIONS = (() => {
  const s = new Set<number>()
  ALL_MATCHES.forEach((m) => {
    if (m.court != null) s.add(m.court)
  })
  return [...s].sort((a, b) => a - b)
})()

function MatchesPage() {
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<'all' | StatusKey>('all')
  const [context, setContext] = useState<'all' | ContextKey>('all')
  const [round, setRound] = useState<string>('all')
  const [court, setCourt] = useState<string>('all')
  const [sort, setSort] = useState<SortState>({ key: 'time', dir: 'desc' })
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(15)

  const filterSig = `${q}|${status}|${context}|${round}|${court}`
  const [lastFilterSig, setLastFilterSig] = useState(filterSig)
  if (lastFilterSig !== filterSig) {
    setLastFilterSig(filterSig)
    setPage(1)
  }

  const filtered = useMemo(() => {
    const ql = q.trim().toLowerCase()
    return ALL_MATCHES.filter((m) => {
      if (status !== 'all' && m.status !== status) return false
      if (context !== 'all' && m.context !== context) return false
      if (round !== 'all' && m.round !== round) return false
      if (court !== 'all' && String(m.court) !== String(court)) return false
      if (ql) {
        const hay = `${m.a.name} ${m.b.name} m-${m.id} ${m.contextLabel}`.toLowerCase()
        if (!hay.includes(ql)) return false
      }
      return true
    })
  }, [q, status, context, round, court])

  const sorted = useMemo(() => {
    const arr = filtered.slice()
    const dirMul = sort.dir === 'asc' ? 1 : -1
    arr.sort((a, b) => {
      switch (sort.key) {
        case 'id':
          return (a.id - b.id) * dirMul
        case 'context':
          return (
            (CONTEXT_ORDER[a.context] - CONTEXT_ORDER[b.context]) * dirMul ||
            a.contextLabel.localeCompare(b.contextLabel)
          )
        case 'round':
          return ((a.roundOrder || 99) - (b.roundOrder || 99)) * dirMul || a.id - b.id
        case 'court':
          return (
            ((a.court ?? 99) - (b.court ?? 99)) * dirMul || a.time.getTime() - b.time.getTime()
          )
        case 'status':
          return (
            (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) * dirMul ||
            a.time.getTime() - b.time.getTime()
          )
        case 'score':
          return ((a.aGames + a.bGames) - (b.aGames + b.bGames)) * dirMul
        case 'time':
        default:
          return (a.time.getTime() - b.time.getTime()) * dirMul
      }
    })
    return arr
  }, [filtered, sort])

  const total = Math.max(1, Math.ceil(sorted.length / pageSize))
  const pageRows = sorted.slice((page - 1) * pageSize, page * pageSize)

  const onClear = () => {
    setQ('')
    setStatus('all')
    setContext('all')
    setRound('all')
    setCourt('all')
  }
  const anyFilter =
    q !== '' || status !== 'all' || context !== 'all' || round !== 'all' || court !== 'all'

  return (
    <AppShell>
      <div className="match-list-page">
        <ActionBar liveCount={COUNTS.live} />
        <FilterRow
          q={q} setQ={setQ}
          status={status} setStatus={setStatus}
          context={context} setContext={setContext}
          round={round} setRound={setRound}
          court={court} setCourt={setCourt}
          counts={COUNTS}
          courtOptions={COURT_OPTIONS}
          onClear={onClear}
          anyFilter={anyFilter}
        />
        <div className="table-wrap">
          <MatchTable
            rows={pageRows}
            sort={sort} setSort={setSort}
            onClear={onClear}
            loading={false}
            pageSize={pageSize}
          />
        </div>
        <PaginationFooter
          page={page} setPage={setPage}
          total={total}
          pageSize={pageSize} setPageSize={setPageSize}
          filteredCount={sorted.length}
          disabled={false}
        />
      </div>
    </AppShell>
  )
}
