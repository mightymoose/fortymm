import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Card } from '../../components/Card'
import { DetailList } from '../../components/DetailList'
import { Meter } from '../../components/Meter'
import { RatingChange } from '../../components/RatingChange'
import { isNotFound, playerQuery, playersQuery } from './mockApi'
import {
  Bone,
  Crumbs,
  KindTag,
  ListHead,
  LoadFailure,
  Loading,
  NoLeagues,
  NoMatches,
  NoPlayers,
  PlayerNotFound,
  Record,
} from './parts'
import { formatDate, lastChangeIn, ordinal, winRate } from './samplePlayers'
import type { DetailScenario, ListScenario } from './scenarios'

const SKELETON_CARDS = 6

function CardBones({ lines }: { lines: number }) {
  return (
    <div className="fm-card stat-card">
      <Bone w="60%" h="20px" />
      <Bone w="40%" />
      <div className="bone-rows">
        {Array.from({ length: lines }, (_, i) => (
          <Bone key={i} h="18px" />
        ))}
      </div>
    </div>
  )
}

// Mockup 2: a card per player, with their rating in each league they play
// in.
export function CardsList({ scenario }: { scenario: ListScenario }) {
  const { data, error, refetch, isFetching } = useQuery(playersQuery(scenario))
  return (
    <section className="players">
      <ListHead lead="Everyone on FortyMM, with their rating in each league. Open a card to see their matches." />
      {error ? (
        <LoadFailure
          error={error}
          subject="the players"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !data ? (
        <Loading label="Loading players">
          <div className="player-cards">
            {Array.from({ length: SKELETON_CARDS }, (_, i) => (
              <CardBones key={i} lines={2} />
            ))}
          </div>
        </Loading>
      ) : data.length === 0 ? (
        <NoPlayers />
      ) : (
        <ul className="player-cards" aria-label="Players">
          {data.map((player) => (
            <li key={player.id}>
              <Card
                title={
                  <Link
                    to="/players/$variant/$playerId"
                    params={{ variant: 'cards', playerId: player.id }}
                    className="player-link"
                  >
                    {player.displayName}
                  </Link>
                }
                subtitle={player.club ?? 'No club'}
                status={<KindTag player={player} />}
              >
                {player.standings.length === 0 ? (
                  <p className="meta">Not in a league yet</p>
                ) : (
                  <ul className="fm-list league-lines" aria-label="Ratings">
                    {player.standings.map((standing) => (
                      <li key={standing.league.id} className="match-line">
                        <span>
                          {standing.league.name}
                          <small>
                            {ordinal(standing.place)} of {standing.of}
                          </small>
                        </span>
                        <span className="num league-lines__rating">{standing.rating}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function CardsDetail({
  playerId,
  scenario,
}: {
  playerId: string
  scenario: DetailScenario
}) {
  const { data: player, error, refetch, isFetching } = useQuery(playerQuery(playerId, scenario))
  if (isNotFound(error)) return <PlayerNotFound variant="cards" />
  return (
    <section className="players">
      <Crumbs variant="cards" current={player?.displayName} />
      {error ? (
        <LoadFailure
          error={error}
          subject="this player"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !player ? (
        <Loading label="Loading player">
          <Bone w="320px" h="40px" />
          <div className="player-cards">
            <CardBones lines={3} />
            <CardBones lines={3} />
            <CardBones lines={3} />
          </div>
        </Loading>
      ) : (
        <>
          <header className="players-head">
            <h1>{player.displayName}</h1>
            <p className="player-hero__meta">
              <KindTag player={player} />
              {player.club && <span>{player.club}</span>}
              <span>Joined {formatDate(player.joinedOn)}</span>
            </p>
          </header>
          {player.standings.length === 0 ? (
            <NoLeagues player={player} />
          ) : (
            <div className="player-cards">
              {player.standings.map((standing) => {
                const change = lastChangeIn(player, standing.league.id)
                return (
                  <Card
                    key={standing.league.id}
                    title={standing.league.name}
                    subtitle={`${ordinal(standing.place)} of ${standing.of}`}
                  >
                    <p className="stat-num">{standing.rating}</p>
                    <p className="meta">
                      {change === null ? (
                        'No change yet'
                      ) : (
                        <>
                          Last change <RatingChange change={change} />
                        </>
                      )}
                    </p>
                    <Meter
                      label={`Win rate in the ${standing.league.name}`}
                      value={standing.wins}
                      max={standing.wins + standing.losses}
                    />
                    <DetailList
                      details={[
                        { term: 'Won–lost', value: <Record {...standing} />, numeric: true },
                        { term: 'Win rate', value: `${winRate(standing)}%`, numeric: true },
                      ]}
                    />
                  </Card>
                )
              })}
            </div>
          )}
          <Card title="Recent matches">
            {player.matches.length === 0 ? (
              <NoMatches player={player} />
            ) : (
              <ul className="fm-list fm-list--divided">
                {player.matches.map((match) => {
                  const won = match.games[0] > match.games[1]
                  return (
                    <li key={match.id} className="match-line">
                      <span>
                        <b className={won ? 'result-won' : 'result-lost'}>
                          {won ? 'Won' : 'Lost'}{' '}
                          <span className="num">
                            {match.games[0]}–{match.games[1]}
                          </span>
                        </b>{' '}
                        against{' '}
                        <Link
                          to="/players/$variant/$playerId"
                          params={{ variant: 'cards', playerId: match.opponentId }}
                          className="player-link"
                        >
                          {match.opponentName}
                        </Link>
                        <small>
                          {match.league.name} · {formatDate(match.playedOn)}
                        </small>
                      </span>
                      <RatingChange change={match.ratingChange} />
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </section>
  )
}
