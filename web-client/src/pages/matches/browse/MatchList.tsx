import { useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { EmptyState } from '../../../components/EmptyState'
import { QueryBoundary } from '../../../components/QueryBoundary'
import { useNarrowLayout } from '../../useNarrowLayout'
import { matchesQuery } from './matchQueries'
import { MatchStatus } from './MatchStatus'
import { ScoreRow } from './ScoreRow'
import { formatDay, formatLabel, formatTime, score, vsLabel, yourSide, type MatchRecord } from './sampleMatches'

const FILTERS = [
  { key: 'live', label: 'Live', test: (m: MatchRecord) => m.status.kind === 'live' },
  {
    key: 'signing',
    label: 'Waiting for sign-off',
    test: (m: MatchRecord) => m.status.kind === 'awaiting' || m.status.kind === 'disputed',
  },
  { key: 'final', label: 'Final', test: (m: MatchRecord) => m.status.kind === 'final' },
  { key: 'yours', label: 'Your matches', test: (m: MatchRecord) => yourSide(m) !== null },
] as const
type FilterKey = (typeof FILTERS)[number]['key']

// A match passes when it's in any state whose chip is on (or no state chip
// is on), and is the viewer's if "Your matches" is on.
function passes(match: MatchRecord, on: readonly FilterKey[]) {
  const states = FILTERS.filter((f) => f.key !== 'yours' && on.includes(f.key))
  const yours = FILTERS[3]
  return (!states.length || states.some((f) => f.test(match))) && (!on.includes('yours') || yours.test(match))
}

// Every match, newest first, narrowed by filter chips. The chips don't
// load anything, so they stay usable while the list loads.
export function MatchList() {
  const [on, setOn] = useState<readonly FilterKey[]>([])
  const toggle = (key: FilterKey) => setOn(on.includes(key) ? on.filter((k) => k !== key) : [...on, key])
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
      <QueryBoundary skeleton={<MatchListSkeleton />}>
        <LoadedMatches on={on} />
      </QueryBoundary>
    </div>
  )
}

function MatchListSkeleton() {
  const narrow = useNarrowLayout()
  return (
    <div className="match-skel-list" aria-busy="true">
      <span className="fm-sr" role="status">
        Loading matches
      </span>
      {[0, 1, 2, 3].map((row) => (
        <div
          key={row}
          className={`fm-skeleton match-skel ${narrow ? 'match-skel--row' : 'match-skel--tr'}`}
          aria-hidden="true"
        />
      ))}
    </div>
  )
}

function LoadedMatches({ on }: { on: readonly FilterKey[] }) {
  const { data: matches } = useSuspenseQuery(matchesQuery())
  const narrow = useNarrowLayout()
  if (!matches.length) return <EmptyState title="No matches yet">Matches show here once someone starts one.</EmptyState>
  const shown = matches.filter((match) => passes(match, on))
  if (!shown.length) return <EmptyState title="No matches here">Turn off a filter to see more matches.</EmptyState>
  return narrow ? <MatchRows matches={shown} /> : <MatchTable matches={shown} />
}

function MatchLink({ match, className, children }: { match: MatchRecord; className?: string; children: ReactNode }) {
  return (
    <Link to="/matches/$matchId" params={{ matchId: match.id }} className={className} aria-label={vsLabel(match)}>
      {children}
    </Link>
  )
}

// Below 900px: the design system's match rows, each a link to its match.
function MatchRows({ matches }: { matches: readonly MatchRecord[] }) {
  return (
    <div className="fm-matches">
      {matches.map((match) => (
        <MatchLink key={match.id} match={match} className="match-row-link">
          <ScoreRow match={match} />
        </MatchLink>
      ))}
    </div>
  )
}

// From 900px: one table row per match. Game scores wrap, so the table fits
// beside the sidebar without scrolling.
function MatchTable({ matches }: { matches: readonly MatchRecord[] }) {
  return (
    <table className="fm-table match-table">
      <thead>
        <tr>
          <th scope="col">Players</th>
          <th scope="col">Status</th>
          <th scope="col" className="n">
            Games
          </th>
          <th scope="col">Game scores</th>
          <th scope="col">Started</th>
        </tr>
      </thead>
      <tbody>
        {matches.map((match) => {
          const { won, winner } = score(match)
          return (
            <tr key={match.id}>
              <td>
                <MatchLink match={match} className="match-players">
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
              <td>
                <div className="match-scores">
                  {match.games.map((game, index) => (
                    <span key={index} className="num">
                      {game[0]}–{game[1]}
                    </span>
                  ))}
                </div>
              </td>
              <td>
                <span className="match-when">
                  {formatDay(match.startedAt)} <span className="num">{formatTime(match.startedAt)}</span>
                </span>
                <span className="match-muted match-block">{formatLabel(match)}</span>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
