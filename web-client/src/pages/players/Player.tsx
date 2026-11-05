import { Link, useParams, useSearch } from '@tanstack/react-router'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { EmptyState } from '../../components/EmptyState'
import { RatingChange } from '../../components/RatingChange'
import { Tabs } from '../../components/Tabs'
import {
  findPlayer,
  gameLine,
  headToHead,
  opponentsOf,
  recordOf,
  resultsOf,
  score,
  shortDate,
  VIEWER_ID,
  type Player,
} from './fixtures'
import { PlayerHeading, PlayerLink, ResultRows } from './parts'
import type { Variant } from './variant'
import { VariantSwitcher } from './VariantSwitcher'
import './players.css'

const names = { a: 'Profile', b: 'Head to head', c: 'Tabs' } as const

// One player's page, in the design option the URL names.
export function PlayerPage() {
  const { playerId } = useParams({ from: '/_authenticated/_shell/players/$playerId' })
  const { variant = 'a' } = useSearch({ from: '/_authenticated/_shell/players/$playerId' })
  const player = findPlayer(playerId)
  return (
    <div className="players">
      <VariantSwitcher current={variant} names={names} playerId={playerId} />
      <nav className="fm-crumbs" aria-label="Breadcrumb">
        <Link to="/players" search={{ variant }}>
          Players
        </Link>
        <span aria-hidden="true">/</span>
        <span aria-current="page">{player?.name ?? 'No such player'}</span>
      </nav>
      {!player ? (
        <EmptyState title="This player isn’t here">
          No player has this address. The link may be wrong.
        </EmptyState>
      ) : variant === 'a' ? (
        <Profile player={player} variant={variant} />
      ) : variant === 'b' ? (
        <HeadToHeadFirst player={player} />
      ) : (
        <Tabbed player={player} />
      )}
    </div>
  )
}

function facts(player: Player) {
  const results = resultsOf(player)
  const { won, lost } = recordOf(results)
  return [
    {
      term: 'Rating',
      value: (
        <>
          {player.rating} {results[0] && <RatingChange change={results[0].change} />}
        </>
      ),
      numeric: true,
    },
    { term: 'Won', value: won, numeric: true },
    { term: 'Lost', value: lost, numeric: true },
    { term: 'Last played', value: results[0] ? shortDate(results[0].date) : 'Not yet' },
  ]
}

// A: the facts, then every result as a row. The split list (players option
// C) shows the same body beside the list.
export function Profile({ player, variant, level = 1 }: { player: Player; variant: Variant; level?: 1 | 2 }) {
  const results = resultsOf(player)
  return (
    <div className="players-page">
      <PlayerHeading player={player} level={level} />
      <DetailList details={facts(player)} />
      <section aria-labelledby={`results-${player.id}`}>
        <h2 className="players-h2" id={`results-${player.id}`}>
          Results
        </h2>
        {results.length ? (
          <ResultRows results={results} variant={variant} />
        ) : (
          <EmptyState title="No matches yet">Their results show here once they play.</EmptyState>
        )}
      </section>
    </div>
  )
}

// B: what the viewer has against this player comes first, then their form,
// then their results.
function HeadToHeadFirst({ player }: { player: Player }) {
  const results = resultsOf(player)
  const meetings = headToHead(player)
  const { won, lost } = recordOf(meetings)
  const isViewer = player.id === VIEWER_ID
  const last = meetings[0]
  return (
    <div className="players-page">
      <PlayerHeading player={player} />
      {isViewer ? (
        <Card title="Your record" subtitle="Every match you’ve logged">
          <DetailList details={facts(player)} />
        </Card>
      ) : (
        <Card
          title={`You and ${player.name.split(',')[0]}`}
          subtitle={meetings.length ? `${meetings.length} matches` : 'You haven’t played yet'}
          actions={
            <Link className="fm-btn fm-btn--primary" to="/matches/new">
              New match
            </Link>
          }
        >
          {meetings.length ? (
            <>
              <p className="players-h2h">
                <span className="num">
                  {won}–{lost}
                </span>
                <span className="meta">
                  {won > lost ? 'You lead' : won < lost ? 'They lead' : 'Level'}
                </span>
              </p>
              <p className="meta">
                Last time, {shortDate(last.date)}: you {last.won ? 'won' : 'lost'}{' '}
                <span className="num">{score(last.games)}</span> ·{' '}
                <span className="num">{gameLine(last.games)}</span>
              </p>
            </>
          ) : (
            <p className="meta">Log a match against them and your record shows here.</p>
          )}
        </Card>
      )}
      {!isViewer && <DetailList details={facts(player)} />}
      <section aria-labelledby="form">
        <h2 className="players-h2" id="form">
          Form
        </h2>
        <ol className="players-form" aria-label="Last five results, newest first">
          {results.slice(0, 5).map((result) => (
            <li key={result.id} className={result.won ? 'w' : undefined}>
              {result.won ? 'W' : 'L'}
              <span className="fm-sr"> against {result.opponent.name}</span>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="results">
        <h2 className="players-h2" id="results">
          Results
        </h2>
        <ResultRows results={results} variant="b" />
      </section>
    </div>
  )
}

// C: a short header, then the results, opponents and rating each on a tab.
function Tabbed({ player }: { player: Player }) {
  const results = resultsOf(player)
  return (
    <div className="players-page">
      <PlayerHeading player={player} />
      <DetailList details={facts(player)} />
      <Tabs
        label="Player"
        tabs={[
          {
            label: 'Results',
            panel: (
              <div className="players-table-wrap">
                <table className="fm-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th>Opponent</th>
                      <th className="n">Games</th>
                      <th>Points</th>
                      <th className="n">Rating</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((result) => (
                      <tr key={result.id}>
                        <td className="meta">{shortDate(result.date)}</td>
                        <td>
                          <PlayerLink player={result.opponent} variant="c" />
                        </td>
                        <td className={result.won ? 'n players-w' : 'n players-l'}>
                          <span className="fm-sr">{result.won ? 'Won ' : 'Lost '}</span>
                          {score(result.games)}
                        </td>
                        <td className="num meta">{gameLine(result.games)}</td>
                        <td className="n">
                          <RatingChange change={result.change} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ),
          },
          {
            label: 'Opponents',
            panel: (
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Opponent</th>
                    <th className="n">Played</th>
                    <th className="n">Won–lost</th>
                  </tr>
                </thead>
                <tbody>
                  {opponentsOf(player).map(({ opponent, results, won, lost }) => (
                    <tr key={opponent.id}>
                      <td>
                        <PlayerLink player={opponent} variant="c" />
                      </td>
                      <td className="n">{results.length}</td>
                      <td className="n">
                        {won}–{lost}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          },
          {
            label: 'Rating',
            panel: (
              <table className="fm-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Match</th>
                    <th className="n">Change</th>
                    <th className="n">Rating after</th>
                  </tr>
                </thead>
                <tbody>
                  {results.map((result) => (
                    <tr key={result.id}>
                      <td className="meta">{shortDate(result.date)}</td>
                      <td>
                        {result.won ? 'Beat' : 'Lost to'} {result.opponent.name}
                      </td>
                      <td className="n">
                        <RatingChange change={result.change} />
                      </td>
                      <td className="n">{result.ratingAfter}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          },
        ]}
      />
    </div>
  )
}
