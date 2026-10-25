import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { useId, useState } from 'react'
import { Button } from '../../components/Button'
import { DetailList } from '../../components/DetailList'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { RatingChange } from '../../components/RatingChange'
import { isNotFound, playerQuery, playersQuery } from './mockApi'
import {
  Avatar,
  Bone,
  KindTag,
  ListHead,
  LoadFailure,
  Loading,
  NoMatches,
  NoLeagues,
  NoPlayers,
  PlayerNotFound,
} from './parts'
import { formatDate, leagueCount, ordinal, record, winRate, type Player } from './samplePlayers'
import type { DetailScenario, ListScenario } from './scenarios'

const SKELETON_ROWS = 8

function RowBones() {
  return (
    <ul className="fm-list fm-list--divided">
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <li key={row} className="player-row">
          <span className="fm-skeleton bone-avatar" />
          <span className="player-row__text">
            <Bone w={`${40 + ((row * 23) % 35)}%`} h="16px" />
            <Bone w="30%" h="12px" />
          </span>
          <Bone w="44px" h="16px" />
        </li>
      ))}
    </ul>
  )
}

function matches(player: Player, search: string): boolean {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean)
  const text = [player.displayName, player.club, ...player.standings.map((s) => s.league.name)]
    .join(' ')
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

// Mockup 3: a searchable list of rows, built for a phone first. A search
// matches a name, a club or a league.
export function RowsList({ scenario }: { scenario: ListScenario }) {
  const { data, error, refetch, isFetching } = useQuery(playersQuery(scenario))
  const [search, setSearch] = useState('')
  const searchId = useId()
  const shown = data?.filter((player) => matches(player, search))

  return (
    <section className="players players--narrow">
      <ListHead lead="Find a player by name, club or league." />
      <div className="fm-field">
        <label className="fm-label" htmlFor={searchId}>
          Search players
        </label>
        <div className="fm-combo">
          <Icon name="search" />
          <input
            id={searchId}
            className="fm-input"
            type="search"
            placeholder="Name, club or league"
            value={search}
            disabled={!data?.length}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>
      {error ? (
        <LoadFailure
          error={error}
          subject="the players"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !data || !shown ? (
        <Loading label="Loading players">
          <RowBones />
        </Loading>
      ) : data.length === 0 ? (
        <NoPlayers />
      ) : shown.length === 0 ? (
        <EmptyState
          title={`No players match “${search.trim()}”`}
          action={
            <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
              Clear search
            </Button>
          }
        >
          Check the spelling, or search for part of a name.
        </EmptyState>
      ) : (
        <>
          <p className="meta" aria-live="polite">
            {shown.length === data.length
              ? `${data.length} players`
              : `${shown.length} of ${data.length} players`}
          </p>
          <ul className="fm-list fm-list--divided" aria-label="Players">
            {shown.map((player) => (
              <li key={player.id}>
                <Link
                  to="/players/$variant/$playerId"
                  params={{ variant: 'rows', playerId: player.id }}
                  className="player-row player-row--link"
                >
                  <Avatar player={player} />
                  <span className="player-row__text">
                    <b>{player.displayName}</b>
                    <small>{player.club ?? 'No club'}</small>
                  </span>
                  <span className="meta">{leagueCount(player)}</span>
                  <Icon name="right" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  )
}

export function RowsDetail({
  playerId,
  scenario,
}: {
  playerId: string
  scenario: DetailScenario
}) {
  const { data: player, error, refetch, isFetching } = useQuery(playerQuery(playerId, scenario))
  if (isNotFound(error)) return <PlayerNotFound variant="rows" />
  return (
    <section className="players players--narrow">
      <Link
        to="/players/$variant"
        params={{ variant: 'rows' }}
        activeOptions={{ exact: true }}
        className="back-link"
      >
        <Icon name="left" />
        Players
      </Link>
      {error ? (
        <LoadFailure
          error={error}
          subject="this player"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !player ? (
        <Loading label="Loading player">
          <div className="player-hero player-hero--center">
            <span className="fm-skeleton bone-avatar bone-avatar--lg" />
            <Bone w="220px" h="32px" />
            <Bone w="80px" h="20px" />
          </div>
          <div className="stat-strip">
            {Array.from({ length: 3 }, (_, i) => (
              <div key={i}>
                <Bone w="60px" h="28px" />
                <Bone w="48px" h="12px" />
              </div>
            ))}
          </div>
          <RowBones />
        </Loading>
      ) : (
        <>
          <div className="player-hero player-hero--center">
            <Avatar player={player} large />
            <h1>{player.displayName}</h1>
            <KindTag player={player} />
          </div>
          <dl className="stat-strip">
            <div>
              <dd className="num">{player.standings.length}</dd>
              <dt>Leagues</dt>
            </div>
            <div>
              <dd className="num">{record(player).wins}</dd>
              <dt>Won</dt>
            </div>
            <div>
              <dd className="num">{record(player).losses}</dd>
              <dt>Lost</dt>
            </div>
          </dl>
          <h2 className="fm-section-title">Ratings</h2>
          {player.standings.length === 0 ? (
            <NoLeagues player={player} />
          ) : (
            <ul className="fm-list fm-list--divided">
              {player.standings.map((standing) => (
                <li key={standing.league.id} className="player-row player-row--plain">
                  <span className="player-row__text">
                    <b>{standing.league.name}</b>
                    <small>
                      {ordinal(standing.place)} of {standing.of} ·{' '}
                      <span className="num">
                        {standing.wins}–{standing.losses}
                      </span>
                    </small>
                  </span>
                  <span className="num stat-inline">{standing.rating}</span>
                </li>
              ))}
            </ul>
          )}
          <h2 className="fm-section-title">Recent matches</h2>
          {player.matches.length === 0 ? (
            <NoMatches player={player} />
          ) : (
            <ul className="fm-list fm-list--divided">
              {player.matches.map((match) => {
                const won = match.games[0] > match.games[1]
                return (
                  <li key={match.id}>
                    <Link
                      to="/players/$variant/$playerId"
                      params={{ variant: 'rows', playerId: match.opponentId }}
                      className="player-row player-row--link"
                    >
                      <span className="player-row__text">
                        <b>{match.opponentName}</b>
                        <small>
                          {won ? 'Won' : 'Lost'}{' '}
                          <span className="num">
                            {match.games[0]}–{match.games[1]}
                          </span>{' '}
                          · {match.league.name} · {formatDate(match.playedOn)}
                        </small>
                      </span>
                      <RatingChange change={match.ratingChange} />
                      <Icon name="right" />
                    </Link>
                  </li>
                )
              })}
            </ul>
          )}
          <h2 className="fm-section-title">About</h2>
          <DetailList
            details={[
              { term: 'Club', value: player.club ?? 'None' },
              { term: 'Joined', value: formatDate(player.joinedOn) },
              {
                term: 'Win rate, all leagues',
                value: winRate(record(player)) === null ? '–' : `${winRate(record(player))}%`,
                numeric: true,
              },
            ]}
          />
        </>
      )}
    </section>
  )
}
