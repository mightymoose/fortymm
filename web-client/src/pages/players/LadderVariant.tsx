import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Meter } from '../../components/Meter'
import { RatingChange } from '../../components/RatingChange'
import { Tabs } from '../../components/Tabs'
import { isNotFound, playerQuery, playersQuery } from './mockApi'
import {
  Bone,
  Crumbs,
  KindTag,
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
  leagues,
  ordinal,
  winRate,
  type League,
  type Player,
  type Standing,
} from './samplePlayers'
import type { DetailScenario, ListScenario } from './scenarios'

const SKELETON_ROWS = 8
const LADDER_TAB_STYLE = { paddingTop: 'var(--s-4)' }

function LadderBones() {
  return (
    <ol className="ladder">
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <li key={row} className="ladder__rung">
          <Bone w="24px" h="24px" />
          <span className="ladder__who">
            <Bone w={`${45 + ((row * 13) % 40)}%`} h="16px" />
            <Bone w="30%" h="12px" />
          </span>
          <Bone w="60px" h="16px" />
          <Bone w="56px" h="16px" />
        </li>
      ))}
    </ol>
  )
}

// Mockup 5: a ladder for each league, a tab each. A player can be on
// several ladders, with a different rating on each.
export function LadderList({ scenario }: { scenario: ListScenario }) {
  const { data, error, refetch, isFetching } = useQuery(playersQuery(scenario))
  return (
    <section className="players">
      <ListHead lead="Each league has its own ladder. Places go by rating in that league." />
      {error ? (
        <LoadFailure
          error={error}
          subject="the ladders"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !data ? (
        <Loading label="Loading the ladders">
          <div className="bone-tabs">
            {leagues.map((league) => (
              <Bone key={league.id} w="160px" h="20px" />
            ))}
          </div>
          <LadderBones />
        </Loading>
      ) : data.length === 0 ? (
        <NoPlayers />
      ) : (
        <Tabs
          label="Leagues"
          panelStyle={LADDER_TAB_STYLE}
          tabs={leagues.map((league) => ({
            label: league.name,
            panel: <LeagueLadder players={data} league={league} />,
          }))}
        />
      )}
    </section>
  )
}

function LeagueLadder({ players, league }: { players: readonly Player[]; league: League }) {
  const rungs = ladder(players, league.id)
  if (rungs.length === 0) return <NoLeaguePlayers league={league} />
  return (
    <ol className="ladder" aria-label={`${league.name} ladder`}>
      {rungs.map(({ player, standing }) => {
        const change = lastChangeIn(player, league.id)
        return (
          <li key={player.id} className="ladder__rung">
            <span className="ladder__place num">{standing.place}</span>
            <span className="ladder__who">
              <Link
                to="/players/$variant/$playerId"
                params={{ variant: 'ladder', playerId: player.id }}
                className="player-link"
              >
                {player.displayName}
              </Link>
              <small>{player.club ?? 'No club'}</small>
            </span>
            <span className="ladder__record">
              <Record {...standing} />
            </span>
            <span className="ladder__rating">
              <span className="num">{standing.rating}</span>
              {change !== null && <RatingChange change={change} />}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function LadderDetail({
  playerId,
  scenario,
}: {
  playerId: string
  scenario: DetailScenario
}) {
  const { data: player, error, refetch, isFetching } = useQuery(playerQuery(playerId, scenario))
  const { data: everyone } = useQuery(playersQuery('ready'))
  if (isNotFound(error)) return <PlayerNotFound variant="ladder" />

  return (
    <section className="players">
      <Crumbs variant="ladder" current={player?.displayName} />
      {error ? (
        <LoadFailure
          error={error}
          subject="this player"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !player || !everyone ? (
        <Loading label="Loading player">
          <Bone w="300px" h="40px" />
          <div className="ladder-detail">
            {Array.from({ length: 2 }, (_, i) => (
              <div key={i} className="fm-card stat-card">
                <Bone w="50%" />
                <Bone w="120px" h="40px" />
                <Bone h="6px" />
                <Bone h="20px" />
                <Bone h="20px" />
              </div>
            ))}
          </div>
          <div className="bone-rows">
            {Array.from({ length: 3 }, (_, i) => (
              <Bone key={i} h="64px" />
            ))}
          </div>
        </Loading>
      ) : (
        <>
          <header className="players-head">
            <h1>{player.displayName}</h1>
            <p className="player-hero__meta">
              <KindTag player={player} />
              <span>{player.club ?? 'No club'}</span>
              <span>Joined {formatDate(player.joinedOn)}</span>
            </p>
          </header>
          {player.standings.length === 0 ? (
            <NoLeagues player={player} />
          ) : (
            <div className="ladder-detail">
              {player.standings.map((standing) => (
                <LadderPlace
                  key={standing.league.id}
                  player={player}
                  standing={standing}
                  everyone={everyone}
                />
              ))}
            </div>
          )}
          <h2 className="h3">Recent matches</h2>
          {player.matches.length === 0 ? (
            <NoMatches player={player} />
          ) : (
            <div className="fm-matches">
              {player.matches.map((match) => {
                const won = match.games[0] > match.games[1]
                return (
                  <article key={match.id} className="fm-match" data-state="final">
                    <div className="fm-match__head">
                      <span>{match.league.name}</span>
                      <span>{formatDate(match.playedOn)}</span>
                      <RatingChange change={match.ratingChange} />
                    </div>
                    <div className={`fm-match__p ${won ? 'w' : 'l'}`}>
                      <span className="fm-match__name">{player.displayName}</span>
                      <span />
                      <span className="fm-match__games" aria-label={`${match.games[0]} games won`}>
                        {match.games[0]}
                      </span>
                    </div>
                    <div className={`fm-match__p ${won ? 'l' : 'w'}`}>
                      <span className="fm-match__name">
                        <Link
                          to="/players/$variant/$playerId"
                          params={{ variant: 'ladder', playerId: match.opponentId }}
                          className="player-link"
                        >
                          {match.opponentName}
                        </Link>
                      </span>
                      <span />
                      <span className="fm-match__games" aria-label={`${match.games[1]} games won`}>
                        {match.games[1]}
                      </span>
                    </div>
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}

// The player's place on one league's ladder, and who is just above and
// below them.
function LadderPlace({
  player,
  standing,
  everyone,
}: {
  player: Player
  standing: Standing
  everyone: readonly Player[]
}) {
  const rungs = ladder(everyone, standing.league.id)
  const at = rungs.findIndex((rung) => rung.player.id === player.id)
  const neighbours = [rungs[at - 1], rungs[at + 1]].filter(Boolean)
  return (
    <section className="fm-card stat-card" aria-label={standing.league.name}>
      <h2 className="fm-card__title">{standing.league.name}</h2>
      <p className="stat-num">
        {ordinal(standing.place)}
        <small> of {standing.of}</small>
      </p>
      <Meter
        label={`Win rate in the ${standing.league.name}`}
        value={standing.wins}
        max={standing.wins + standing.losses}
      />
      <p className="meta">
        Rating <span className="num">{standing.rating}</span> · won {winRate(standing)}% of{' '}
        {standing.wins + standing.losses} matches
      </p>
      {neighbours.length > 0 && (
        <ul className="fm-list fm-list--divided" aria-label="Nearby on the ladder">
          {neighbours.map(({ player: other, standing: theirs }) => {
            const gap = theirs.rating - standing.rating
            return (
              <li key={other.id} className="match-line">
                <span>
                  <span className="num">{theirs.place}.</span>{' '}
                  <Link
                    to="/players/$variant/$playerId"
                    params={{ variant: 'ladder', playerId: other.id }}
                    className="player-link"
                  >
                    {other.displayName}
                  </Link>
                  <small>
                    {gap > 0 ? `${gap} points above` : `${-gap} points below`}{' '}
                    {player.displayName}
                  </small>
                </span>
                <span className="num">{theirs.rating}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
