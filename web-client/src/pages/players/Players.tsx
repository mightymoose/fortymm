import { Link, useSearch } from '@tanstack/react-router'
import { useId, useState, type ReactNode } from 'react'
import { EmptyState } from '../../components/EmptyState'
import { FilterChips } from '../../components/FilterChips'
import { PlayerAvatar } from '../../components/PlayerAvatar'
import { RatingChange } from '../../components/RatingChange'
import { SplitView } from '../../components/SplitView'
import { useNarrowLayout } from '../useNarrowLayout'
import {
  headToHead,
  players,
  recordOf,
  resultsOf,
  shortDate,
  viewer,
  VIEWER_ID,
  type Player,
} from './fixtures'
import { PlayerLink, YouTag } from './parts'
import { Profile } from './Player'
import { VariantSwitcher } from './VariantSwitcher'
import './players.css'

const names = { a: 'Ranking table', b: 'Your people', c: 'Split view' } as const
const clubs = [...new Set(players.map((player) => player.club))].sort()

const matches = (player: Player, query: string) =>
  player.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())

// The players page, in the design option the URL names.
export function Players() {
  const { variant = 'a' } = useSearch({ from: '/_authenticated/_shell/players/' })
  return (
    <div className="players">
      <VariantSwitcher current={variant} names={names} />
      <h1>Players</h1>
      {variant === 'a' ? <RankingTable /> : variant === 'b' ? <YourPeople /> : <Split />}
    </div>
  )
}

function Search({ query, onChange }: { query: string; onChange: (query: string) => void }) {
  const id = useId()
  return (
    <div className="fm-field players-search" role="search">
      <label className="fm-label" htmlFor={id}>
        Find a player
      </label>
      <input
        id={id}
        className="fm-input"
        type="search"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  )
}

function NoMatch({ query }: { query: string }) {
  return <EmptyState title="No players match">No player’s name contains “{query.trim()}”.</EmptyState>
}

// A: everyone ranked by rating in one table, with search and club filters.
function RankingTable() {
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState<string[]>(['All clubs'])
  const ranked = [...players].sort((a, b) => b.rating - a.rating)
  const rows = ranked.filter(
    (player) => matches(player, query) && (shown.includes('All clubs') || shown.includes(player.club)),
  )
  return (
    <>
      <div className="players-tools">
        <Search query={query} onChange={setQuery} />
        <FilterChips label="Filter by club" allLabel="All clubs" options={clubs} onChange={setShown} />
      </div>
      {rows.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <div className="players-table-wrap">
          <table className="fm-table players-ranking">
            <thead>
              <tr>
                <th className="n">#</th>
                <th>Player</th>
                <th className="n">Rating</th>
                <th className="n">Last change</th>
                <th className="n">Won–lost</th>
                <th>Last played</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((player) => {
                const results = resultsOf(player)
                const { won, lost } = recordOf(results)
                return (
                  <tr key={player.id} aria-current={player.id === VIEWER_ID ? 'true' : undefined}>
                    <td className="n meta">{ranked.indexOf(player) + 1}</td>
                    <td>
                      <span className="players-name">
                        <PlayerLink player={player} variant="a" /> <YouTag player={player} />
                      </span>
                      <span className="meta">{player.club}</span>
                    </td>
                    <td className="n">{player.rating}</td>
                    <td className="n">{results[0] ? <RatingChange change={results[0].change} /> : '–'}</td>
                    <td className="n">
                      {won}–{lost}
                    </td>
                    <td className="meta">{results[0] ? shortDate(results[0].date) : 'Not yet'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function PlayerRow({ player, aside }: { player: Player; aside: ReactNode }) {
  return (
    <li className="players-row">
      <PlayerAvatar name={player.name} />
      <span className="players-row__who">
        <span className="players-name">
          <PlayerLink player={player} variant="b" /> <YouTag player={player} />
        </span>
        <span className="meta">{player.club}</span>
      </span>
      <span className="players-row__aside">{aside}</span>
    </li>
  )
}

// B: rows grouped by how the viewer knows each player. You first, then the
// people you've played with your record against each, then everyone else.
function YourPeople() {
  const [query, setQuery] = useState('')
  const played = new Map<string, Player>()
  for (const result of resultsOf(viewer)) played.set(result.opponent.id, result.opponent)
  const opponents = [...played.values()].filter((player) => matches(player, query))
  const others = players
    .filter((player) => player.id !== VIEWER_ID && !played.has(player.id) && matches(player, query))
    .sort((a, b) => a.name.localeCompare(b.name))
  const showViewer = matches(viewer, query)
  const rating = (player: Player) => <span className="num players-rating">{player.rating}</span>

  return (
    <>
      <Search query={query} onChange={setQuery} />
      {!showViewer && !opponents.length && !others.length && <NoMatch query={query} />}
      {showViewer && (
        <ul className="fm-list">
          <PlayerRow player={viewer} aside={rating(viewer)} />
        </ul>
      )}
      {opponents.length > 0 && (
        <section aria-labelledby="played">
          <h2 className="players-h2" id="played">
            You’ve played
          </h2>
          <ul className="fm-list fm-list--divided">
            {opponents.map((player) => {
              const { won, lost } = recordOf(headToHead(player))
              return (
                <PlayerRow
                  key={player.id}
                  player={player}
                  aside={
                    <>
                      <span className="meta">
                        You’re{' '}
                        <span className="num">
                          {won}–{lost}
                        </span>
                      </span>
                      {rating(player)}
                    </>
                  }
                />
              )
            })}
          </ul>
        </section>
      )}
      {others.length > 0 && (
        <section aria-labelledby="others">
          <h2 className="players-h2" id="others">
            Everyone else
          </h2>
          <ul className="fm-list fm-list--divided">
            {others.map((player) => (
              <PlayerRow key={player.id} player={player} aside={rating(player)} />
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

// C: the list beside the chosen player's page. Narrow screens get the list
// alone, each name linking to the player's page.
function Split() {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(VIEWER_ID)
  const narrow = useNarrowLayout()
  const rows = [...players].sort((a, b) => a.name.localeCompare(b.name)).filter((p) => matches(p, query))
  const chosen = players.find((player) => player.id === selected)!

  const list = (
    <div className="players-split__list">
      <Search query={query} onChange={setQuery} />
      {rows.length === 0 ? (
        <NoMatch query={query} />
      ) : (
        <ul className="fm-list players-pick">
          {rows.map((player) => (
            <li key={player.id}>
              {narrow ? (
                <Link
                  className="players-pick__opt"
                  to="/players/$playerId"
                  params={{ playerId: player.id }}
                  search={{ variant: 'a' }}
                >
                  <PickLabel player={player} />
                </Link>
              ) : (
                <button
                  type="button"
                  className="players-pick__opt"
                  aria-pressed={player.id === selected}
                  onClick={() => setSelected(player.id)}
                >
                  <PickLabel player={player} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  if (narrow) return list
  return (
    <SplitView
      label="Resize the list and the player"
      start={list}
      end={
        <div className="players-split__detail" aria-live="polite">
          <Profile player={chosen} variant="a" level={2} />
        </div>
      }
    />
  )
}

function PickLabel({ player }: { player: Player }) {
  return (
    <>
      <PlayerAvatar name={player.name} />
      <span className="players-row__who">
        <span className="players-name">
          {player.name} <YouTag player={player} />
        </span>
        <span className="meta">{player.club}</span>
      </span>
      <span className="num players-rating">{player.rating}</span>
    </>
  )
}
