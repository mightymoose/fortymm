import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useState, type ReactNode } from 'react'
import { DetailList } from '../../components/DetailList'
import { RatingChange } from '../../components/RatingChange'
import { isNotFound, playerQuery, playersQuery } from './mockApi'
import {
  Avatar,
  Bone,
  Crumbs,
  KindTag,
  LeagueSelect,
  ListHead,
  LoadFailure,
  Loading,
  NoLeaguePlayers,
  NoLeagues,
  NoMatches,
  NoPlayers,
  PlayerNotFound,
  Record,
} from './parts'
import {
  formatDate,
  ladder,
  lastChangeIn,
  lastPlayedOn,
  leagues,
  record,
  winRate,
} from './samplePlayers'
import type { DetailScenario, ListScenario } from './scenarios'

const SKELETON_ROWS = 8

// Mockup 1: a dense ratings table of one league at a time, ranked by
// rating in that league.
export function TableList({ scenario }: { scenario: ListScenario }) {
  const { data, error, refetch, isFetching } = useQuery(playersQuery(scenario))
  const [leagueId, setLeagueId] = useState(leagues[0].id)
  const league = leagues.find((l) => l.id === leagueId)!
  const rungs = data ? ladder(data, leagueId) : []

  return (
    <section className="players">
      <ListHead lead="Each league rates its players on its own. Pick a league to see its table." />
      {error ? (
        <LoadFailure
          error={error}
          subject="the players"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !data ? (
        <Loading label="Loading players">
          <span className="league-select">
            <Bone w="60px" h="14px" />
            <Bone w="100%" h="44px" />
          </span>
          <PlayersTable>
            {Array.from({ length: SKELETON_ROWS }, (_, row) => (
              <tr key={row}>
                <td className="n"><Bone w="16px" /></td>
                <td>
                  <span className="player-cell">
                    <span className="fm-skeleton bone-avatar" />
                    <Bone w={`${50 + ((row * 17) % 40)}%`} />
                  </span>
                </td>
                <td><Bone w="70%" /></td>
                <td className="n"><Bone w="40px" /></td>
                <td className="n"><Bone w="36px" /></td>
                <td className="n"><Bone w="40px" /></td>
                <td><Bone w="80px" /></td>
              </tr>
            ))}
          </PlayersTable>
        </Loading>
      ) : data.length === 0 ? (
        <NoPlayers />
      ) : (
        <>
          <LeagueSelect value={leagueId} onChange={setLeagueId} />
          {rungs.length === 0 ? (
            <NoLeaguePlayers league={league} />
          ) : (
            <PlayersTable>
              {rungs.map(({ player, standing }) => {
                const change = lastChangeIn(player, leagueId)
                const last = player.matches.find((m) => m.league.id === leagueId)
                return (
                  <tr key={player.id}>
                    <td className="n">{standing.place}</td>
                    <td>
                      <span className="player-cell">
                        <Avatar player={player} />
                        <Link
                          to="/players/$variant/$playerId"
                          params={{ variant: 'table', playerId: player.id }}
                          className="player-link"
                        >
                          {player.displayName}
                        </Link>
                      </span>
                    </td>
                    <td>{player.club ?? <span className="unrated">No club</span>}</td>
                    <td className="n">{standing.rating}</td>
                    <td className="n">
                      {change === null ? '–' : <RatingChange change={change} />}
                    </td>
                    <td className="n">
                      <Record {...standing} />
                    </td>
                    <td>{last ? formatDate(last.playedOn) : 'Not yet'}</td>
                  </tr>
                )
              })}
            </PlayersTable>
          )}
        </>
      )}
    </section>
  )
}

function PlayersTable({ children }: { children: ReactNode }) {
  return (
    <div className="fm-scroll" tabIndex={0} aria-label="Players by rating">
      <table className="fm-table players-table">
        <colgroup>
          <col style={{ width: '64px' }} />
          <col />
          <col style={{ width: '22%' }} />
          <col style={{ width: '88px' }} />
          <col style={{ width: '112px' }} />
          <col style={{ width: '96px' }} />
          <col style={{ width: '124px' }} />
        </colgroup>
        <thead>
          <tr>
            <th scope="col" className="n">Place</th>
            <th scope="col">Player</th>
            <th scope="col">Club</th>
            <th scope="col" className="n">Rating</th>
            <th scope="col" className="n">Last change</th>
            <th scope="col" className="n">Won–lost</th>
            <th scope="col">Last played</th>
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  )
}

export function TableDetail({
  playerId,
  scenario,
}: {
  playerId: string
  scenario: DetailScenario
}) {
  const { data: player, error, refetch, isFetching } = useQuery(playerQuery(playerId, scenario))
  if (isNotFound(error)) return <PlayerNotFound variant="table" />
  const total = player && record(player)
  const last = player && lastPlayedOn(player)
  return (
    <section className="players">
      <Crumbs variant="table" current={player?.displayName} />
      {error ? (
        <LoadFailure
          error={error}
          subject="this player"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !player || !total ? (
        <Loading label="Loading player">
          <div className="player-hero">
            <span className="fm-skeleton bone-avatar bone-avatar--lg" />
            <div className="player-hero__text">
              <Bone w="260px" h="40px" />
              <Bone w="180px" />
            </div>
          </div>
          <div className="fm-dl bone-dl">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i}>
                <Bone w="60px" h="12px" />
                <Bone w="90px" h="20px" />
              </div>
            ))}
          </div>
          <Bone w="160px" h="20px" />
          <div className="bone-rows">
            {Array.from({ length: 6 }, (_, i) => (
              <Bone key={i} h="20px" />
            ))}
          </div>
        </Loading>
      ) : (
        <>
          <div className="player-hero">
            <Avatar player={player} large />
            <div className="player-hero__text">
              <h1>{player.displayName}</h1>
              <p className="player-hero__meta">
                <KindTag player={player} />
                {player.club && <span>{player.club}</span>}
                <span>Joined {formatDate(player.joinedOn)}</span>
              </p>
            </div>
          </div>
          <DetailList
            details={[
              { term: 'Won–lost, all leagues', value: <Record {...total} />, numeric: true },
              {
                term: 'Win rate',
                value: winRate(total) === null ? '–' : `${winRate(total)}%`,
                numeric: true,
              },
              { term: 'Last played', value: last ? formatDate(last) : 'Never' },
            ]}
          />
          <h2 className="h3">Leagues</h2>
          {player.standings.length === 0 ? (
            <NoLeagues player={player} />
          ) : (
            <div className="fm-scroll" tabIndex={0} aria-label="Leagues">
              <table className="fm-table">
                <thead>
                  <tr>
                    <th scope="col">League</th>
                    <th scope="col" className="n">Place</th>
                    <th scope="col" className="n">Rating</th>
                    <th scope="col" className="n">Won–lost</th>
                  </tr>
                </thead>
                <tbody>
                  {player.standings.map((standing) => (
                    <tr key={standing.league.id}>
                      <td>{standing.league.name}</td>
                      <td className="n">
                        {standing.place} of {standing.of}
                      </td>
                      <td className="n">{standing.rating}</td>
                      <td className="n">
                        <Record {...standing} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h2 className="h3">Recent matches</h2>
          {player.matches.length === 0 ? (
            <NoMatches player={player} />
          ) : (
            <div className="fm-scroll" tabIndex={0} aria-label="Recent matches">
              <table className="fm-table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Opponent</th>
                    <th scope="col">League</th>
                    <th scope="col">Result</th>
                    <th scope="col" className="n">Games</th>
                    <th scope="col" className="n">Rating</th>
                  </tr>
                </thead>
                <tbody>
                  {player.matches.map((match) => {
                    const won = match.games[0] > match.games[1]
                    return (
                      <tr key={match.id}>
                        <td>{formatDate(match.playedOn)}</td>
                        <td>
                          <Link
                            to="/players/$variant/$playerId"
                            params={{ variant: 'table', playerId: match.opponentId }}
                            className="player-link"
                          >
                            {match.opponentName}
                          </Link>
                        </td>
                        <td>{match.league.name}</td>
                        <td className={won ? 'result-won' : 'result-lost'}>
                          {won ? 'Won' : 'Lost'}
                        </td>
                        <td className="n">
                          {match.games[0]}–{match.games[1]}
                        </td>
                        <td className="n">
                          <RatingChange change={match.ratingChange} />
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
