import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { EmptyState } from '../../../components/EmptyState'
import {
  formatDay,
  formatLabel,
  formatTime,
  needsYou,
  opponent,
  sampleMatches,
  score,
  yourSide,
  type MatchRecord,
  type Side,
} from './sampleMatches'
import { MatchStatus, RatingChange } from './parts'
import { vsLabel, type Variant } from './variants'

export function MatchList({ variant }: { variant: Variant }) {
  if (variant === 'b') return <HistoryTable />
  if (variant === 'c') return <TabbedCards />
  return <GroupedRows />
}

function MatchLink({ match, variant, children, className }: {
  match: MatchRecord
  variant: Variant
  children: React.ReactNode
  className?: string
}) {
  return (
    <Link to="/matches/$matchId" params={{ matchId: match.id }} search={{ variant }} className={className}>
      {children}
    </Link>
  )
}

// A: the design system's match rows, grouped by what the viewer can do:
// matches waiting on them, matches in play, then the rest by day.
function GroupedRows() {
  const waiting = sampleMatches.filter(needsYou)
  const live = sampleMatches.filter((match) => match.status.kind === 'live')
  const rest = sampleMatches.filter((match) => !needsYou(match) && match.status.kind !== 'live')
  const days = [...new Set(rest.map((match) => formatDay(match.startedAt)))]
  return (
    <div className="match-groups">
      <RowGroup title="Needs you" matches={waiting} />
      <RowGroup title="Live" matches={live} />
      {days.map((day) => (
        <RowGroup key={day} title={day} matches={rest.filter((match) => formatDay(match.startedAt) === day)} />
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
        {title}
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
  const live = match.status.kind === 'live'
  const state = live ? 'live' : 'final'
  return (
    <article className={large ? 'fm-match fm-match--lg' : 'fm-match'} data-state={state} aria-label={vsLabel(match)}>
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
  { key: 'live', label: 'Live', test: (m: MatchRecord) => m.status.kind === 'live' },
  { key: 'you', label: 'Needs you', test: needsYou },
  { key: 'final', label: 'Final', test: (m: MatchRecord) => m.status.kind === 'final' },
] as const
type FilterKey = (typeof FILTERS)[number]['key']

// B: a dense history table, newest first, narrowed by filter chips. Scores
// read from the viewer's side.
function HistoryTable() {
  const [on, setOn] = useState<readonly FilterKey[]>([])
  const toggle = (key: FilterKey) => setOn(on.includes(key) ? on.filter((k) => k !== key) : [...on, key])
  const shown = on.length
    ? sampleMatches.filter((match) => FILTERS.some((f) => on.includes(f.key) && f.test(match)))
    : sampleMatches
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
                <th scope="col">Opponent</th>
                <th scope="col">Status</th>
                <th scope="col" className="n">Games</th>
                <th scope="col">Game scores</th>
                <th scope="col" className="n">Rating</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((match) => {
                const mine = yourSide(match) ?? 0
                const theirs: Side = mine === 0 ? 1 : 0
                const { won, winner } = score(match)
                return (
                  <tr key={match.id}>
                    <td>
                      {formatDay(match.startedAt)} <span className="num match-muted">{formatTime(match.startedAt)}</span>
                    </td>
                    <td>
                      <MatchLink match={match} variant="b">
                        {opponent(match).name}
                      </MatchLink>
                      <span className="match-muted match-block">{formatLabel(match)}</span>
                    </td>
                    <td>
                      <MatchStatus match={match} />
                    </td>
                    <td className={winner === mine ? 'n match-strong' : 'n'}>
                      {won[mine]}–{won[theirs]}
                    </td>
                    <td className="num match-muted">
                      {match.games.map((game) => `${game[mine]}–${game[theirs]}`).join('  ')}
                    </td>
                    <td className="n">
                      <RatingChange match={match} />
                    </td>
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
  { key: 'todo', label: 'To do', test: needsYou },
  { key: 'live', label: 'Live', test: (m: MatchRecord) => m.status.kind === 'live' },
  { key: 'done', label: 'Finished', test: (m: MatchRecord) => !needsYou(m) && m.status.kind !== 'live' },
] as const

// C: tabs by what's left to do, each match a card that leads with its next
// action.
function TabbedCards() {
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('todo')
  const id = useId()
  const current = TABS.find((t) => t.key === tab) ?? TABS[0]
  const shown = sampleMatches.filter(current.test)
  return (
    <div className="match-groups">
      <div className="fm-tabs" role="tablist" aria-label="Matches by status">
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
          <EmptyState title="Nothing to do">No match is waiting on you.</EmptyState>
        ) : (
          shown.map((match) => <ActionCard key={match.id} match={match} />)
        )}
      </div>
    </div>
  )
}

function nextAction(match: MatchRecord): { label: string; primary: boolean } {
  if (match.status.kind === 'live') return { label: 'Keep score', primary: true }
  if (match.status.kind === 'disputed') return { label: 'Review their scores', primary: true }
  if (needsYou(match)) return { label: 'Review and approve', primary: true }
  return { label: 'View match', primary: false }
}

function ActionCard({ match }: { match: MatchRecord }) {
  const id = useId()
  const { won } = score(match)
  const mine = yourSide(match) ?? 0
  const theirs: Side = mine === 0 ? 1 : 0
  const action = nextAction(match)
  return (
    <section className="fm-card" aria-labelledby={id}>
      <div className="fm-card__head">
        <div>
          <h3 className="fm-card__title" id={id}>
            vs {opponent(match).name}
          </h3>
          <p className="fm-card__sub">
            {formatDay(match.startedAt)} · {formatLabel(match)}
          </p>
        </div>
        <MatchStatus match={match} />
      </div>
      <div className="fm-card__body">
        <dl className="fm-dl">
          <div>
            <dt>Games, you first</dt>
            <dd className="num">
              {won[mine]}–{won[theirs]}
            </dd>
          </div>
          <div>
            <dt>Scores</dt>
            <dd className="num">{match.games.map((game) => `${game[mine]}–${game[theirs]}`).join(' ')}</dd>
          </div>
          {match.status.kind === 'final' && match.status.rating && (
            <div>
              <dt>Rating</dt>
              <dd>
                <RatingChange match={match} />
              </dd>
            </div>
          )}
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
