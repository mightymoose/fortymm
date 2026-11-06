import { Link } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { EmptyState } from '../../../components/EmptyState'
import {
  formatDay,
  formatLabel,
  formatTime,
  needsYou,
  sampleMatches,
  score,
  yourSide,
  type MatchRecord,
  type Side,
} from './sampleMatches'
import { MatchStatus } from './parts'
import { vsLabel, type Variant } from './variants'

// Every match, not only the viewer's. Scores read in side order.
export function MatchList({ variant }: { variant: Variant }) {
  if (variant === 'b') return <HistoryTable />
  if (variant === 'c') return <TabbedCards />
  return <GroupedRows />
}

const isLive = (match: MatchRecord) => match.status.kind === 'live'
const isSigning = (match: MatchRecord) => match.status.kind === 'awaiting' || match.status.kind === 'disputed'
const isFinal = (match: MatchRecord) => match.status.kind === 'final'
const isYours = (match: MatchRecord) => yourSide(match) !== null

// Disputes first: they're the ones stuck until a player acts.
const signingOrder = (a: MatchRecord, b: MatchRecord) =>
  Number(b.status.kind === 'disputed') - Number(a.status.kind === 'disputed')

function MatchLink({ match, variant, children, className }: {
  match: MatchRecord
  variant: Variant
  children: ReactNode
  className?: string
}) {
  return (
    <Link to="/matches/$matchId" params={{ matchId: match.id }} search={{ variant }} className={className}>
      {children}
    </Link>
  )
}

// A: the design system's match rows, grouped by state: live, then waiting
// for sign-off, then final matches by day.
function GroupedRows() {
  const live = sampleMatches.filter(isLive)
  const signing = sampleMatches.filter(isSigning).sort(signingOrder)
  const final = sampleMatches.filter(isFinal)
  const days = [...new Set(final.map((match) => formatDay(match.startedAt)))]
  return (
    <div className="match-groups">
      <RowGroup title="Live" matches={live} />
      <RowGroup title="Waiting for sign-off" matches={signing} />
      {days.map((day) => (
        <RowGroup key={day} title={day} matches={final.filter((match) => formatDay(match.startedAt) === day)} />
      ))}
    </div>
  )
}

function RowGroup({ title, matches }: { title: string; matches: readonly MatchRecord[] }) {
  const id = useId()
  if (!matches.length) return null
  return (
    <section aria-labelledby={id}>
      <h2 className="fm-section-title" id={id}>
        {title} <span className="num match-muted">{matches.length}</span>
      </h2>
      <div className="fm-matches">
        {matches.map((match) => (
          <MatchLink key={match.id} match={match} variant="a" className="match-row-link">
            <ScoreRow match={match} />
          </MatchLink>
        ))}
      </div>
    </section>
  )
}

// One `.fm-match` row: status and format, then each player with games won
// (boxed) and, while live, the points in the game in play.
export function ScoreRow({ match, large = false, headHidden = false }: {
  match: MatchRecord
  large?: boolean
  headHidden?: boolean
}) {
  const { current, won, winner } = score(match)
  const live = isLive(match)
  return (
    <article
      className={large ? 'fm-match fm-match--lg' : 'fm-match'}
      data-state={live ? 'live' : 'final'}
      aria-label={vsLabel(match)}
    >
      <div className="fm-match__head" hidden={headHidden}>
        <MatchStatus match={match} />
        <span>
          {formatLabel(match)} · <span className="num">{formatTime(match.startedAt)}</span>
          {live && ` · Game ${match.games.length}`}
        </span>
      </div>
      <div className="fm-match__p fm-match__cols" aria-hidden="true">
        <span></span>
        <span></span>
        <span>Games</span>
        {live && <span>Points</span>}
      </div>
      {([0, 1] as const).map((side: Side) => {
        const player = match.players[side]
        const result = winner === null ? '' : winner === side ? ' w' : ' l'
        return (
          <div key={side} className={`fm-match__p${result}`}>
            <span className="fm-match__name">
              {player.name}
              {player.you && <small>You</small>}
            </span>
            <span>
              {match.status.kind === 'live' && match.status.serve === side && (
                <span className="serve-marker" role="img" aria-label="Serving"></span>
              )}
            </span>
            <span className="fm-match__games" aria-label={`${won[side]} games won`}>
              {won[side]}
            </span>
            {live && (
              <span className="fm-match__pts" aria-label={`${current?.[side] ?? 0} points in this game`}>
                {current?.[side] ?? 0}
              </span>
            )}
          </div>
        )
      })}
    </article>
  )
}

const FILTERS = [
  { key: 'live', label: 'Live', test: isLive },
  { key: 'signing', label: 'Waiting for sign-off', test: isSigning },
  { key: 'final', label: 'Final', test: isFinal },
  { key: 'yours', label: 'Your matches', test: isYours },
] as const
type FilterKey = (typeof FILTERS)[number]['key']
const STATE_FILTERS: readonly FilterKey[] = ['live', 'signing', 'final']

const gameScores = (match: MatchRecord) => match.games.map((game) => `${game[0]}–${game[1]}`).join('  ')

// B: a dense table of every match, newest first, narrowed by filter chips.
// The state chips widen each other (any of them); "Your matches" narrows.
function HistoryTable() {
  const [on, setOn] = useState<readonly FilterKey[]>([])
  const toggle = (key: FilterKey) => setOn(on.includes(key) ? on.filter((k) => k !== key) : [...on, key])
  const states = FILTERS.filter((f) => STATE_FILTERS.includes(f.key) && on.includes(f.key))
  const shown = sampleMatches.filter(
    (match) => (!states.length || states.some((f) => f.test(match))) && (!on.includes('yours') || isYours(match)),
  )
  return (
    <div className="match-groups">
      <div className="fm-chips" aria-label="Filter matches">
        <button type="button" className="fm-chip" aria-pressed={on.length === 0} onClick={() => setOn([])}>
          All matches
        </button>
        {FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className="fm-chip"
            aria-pressed={on.includes(filter.key)}
            onClick={() => toggle(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <EmptyState title="No matches here">Turn off a filter to see more matches.</EmptyState>
      ) : (
        <div className="match-table-wrap">
          <table className="fm-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Players</th>
                <th scope="col">Status</th>
                <th scope="col" className="n">Games</th>
                <th scope="col">Game scores</th>
                <th scope="col">Format</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((match) => {
                const { won, winner } = score(match)
                return (
                  <tr key={match.id}>
                    <td>
                      {formatDay(match.startedAt)} <span className="num match-muted">{formatTime(match.startedAt)}</span>
                    </td>
                    <td>
                      <MatchLink match={match} variant="b" className="match-players">
                        {([0, 1] as const).map((side) => (
                          <span
                            key={side}
                            className={winner === null ? undefined : winner === side ? 'match-strong' : 'match-muted'}
                          >
                            {match.players[side].name}
                            {match.players[side].you && ' (you)'}
                          </span>
                        ))}
                      </MatchLink>
                    </td>
                    <td>
                      <MatchStatus match={match} />
                    </td>
                    <td className="n">
                      {won[0]}–{won[1]}
                    </td>
                    <td className="num match-muted">{gameScores(match)}</td>
                    <td className="match-muted">{formatLabel(match)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const TABS = [
  { key: 'live', label: 'Live', test: isLive },
  { key: 'signing', label: 'Waiting for sign-off', test: isSigning },
  { key: 'final', label: 'Final', test: isFinal },
] as const

// C: tabs by state, each match a card that leads with what can be done
// with it: keep score, sign, or look.
function TabbedCards() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('live')
  const id = useId()
  const current = TABS.find((t) => t.key === tab) ?? TABS[0]
  const shown = sampleMatches.filter(current.test)
  if (tab === 'signing') shown.sort(signingOrder)
  return (
    <div className="match-groups">
      <div className="fm-tabs" role="tablist" aria-label="Matches by state">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            id={`${id}-${t.key}`}
            aria-selected={t.key === tab}
            aria-controls={`${id}-panel`}
            onClick={() => setTab(t.key)}
          >
            {t.label} <span className="num match-muted">{sampleMatches.filter(t.test).length}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} className="match-cards">
        {shown.length === 0 ? (
          <EmptyState title="No matches here">No match is in this state right now.</EmptyState>
        ) : (
          shown.map((match) => <ActionCard key={match.id} match={match} />)
        )}
      </div>
    </div>
  )
}

function nextAction(match: MatchRecord): { label: string; primary: boolean } {
  if (needsYou(match))
    return { label: match.status.kind === 'disputed' ? 'Review their scores' : 'Review and approve', primary: true }
  if (isLive(match)) return { label: 'Keep score', primary: false }
  return { label: 'View match', primary: false }
}

function ActionCard({ match }: { match: MatchRecord }) {
  const id = useId()
  const { won, winner } = score(match)
  const action = nextAction(match)
  return (
    <section className="fm-card" aria-labelledby={id}>
      <div className="fm-card__head">
        <div>
          <h3 className="fm-card__title" id={id}>
            {vsLabel(match)}
          </h3>
          <p className="fm-card__sub">
            {formatDay(match.startedAt)} · {formatLabel(match)}
            {isYours(match) && ' · Your match'}
          </p>
        </div>
        <MatchStatus match={match} />
      </div>
      <div className="fm-card__body">
        <dl className="fm-dl">
          <div>
            <dt>Games</dt>
            <dd className="num">
              <span className={winner === 0 ? 'match-strong' : undefined}>{won[0]}</span>–
              <span className={winner === 1 ? 'match-strong' : undefined}>{won[1]}</span>
            </dd>
          </div>
          <div>
            <dt>Scores</dt>
            <dd className="num">{gameScores(match)}</dd>
          </div>
        </dl>
      </div>
      <div className="fm-card__foot">
        <MatchLink
          match={match}
          variant="c"
          className={action.primary ? 'fm-btn fm-btn--primary' : 'fm-btn fm-btn--secondary'}
        >
          {action.label}
        </MatchLink>
      </div>
    </section>
  )
}
