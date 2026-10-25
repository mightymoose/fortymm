import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { DetailList } from '../../components/DetailList'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { RatingChange } from '../../components/RatingChange'
import { SplitView } from '../../components/SplitView'
import { Tabs } from '../../components/Tabs'
import { isNotFound, playerQuery, playersQuery } from './mockApi'
import {
  Avatar,
  Bone,
  KindTag,
  LoadFailure,
  Loading,
  NoLeagues,
  NoMatches,
  NoPlayers,
  PlayerNotFound,
  Record,
} from './parts'
import {
  formatDate,
  leagueCount,
  ordinal,
  winRate,
  type MatchResult,
  type Player,
  type Standing,
} from './samplePlayers'
import type { DetailScenario, ListScenario } from './scenarios'

const SKELETON_ROWS = 9

// Mockup 4: the list and one player side by side. The player's page is the
// same view with that player open, with a tab for each of their leagues. Below 900px the panes stack, and an open
// player hides the list behind a back link.
export function SplitList({ scenario }: { scenario: ListScenario }) {
  return <SplitPlayers listScenario={scenario} />
}

export function SplitDetail({
  playerId,
  scenario,
}: {
  playerId: string
  scenario: DetailScenario
}) {
  return (
    <SplitPlayers listScenario="ready" selected={{ playerId, scenario }} />
  )
}

function SplitPlayers({
  listScenario,
  selected,
}: {
  listScenario: ListScenario
  selected?: { playerId: string; scenario: DetailScenario }
}) {
  return (
    <section className="players split-players" data-open={!!selected}>
      <SplitView
        label="Resize the list"
        start={<PlayerPicker scenario={listScenario} />}
        end={
          <div className="split-players__pane">
            {selected ? (
              <PlayerPane {...selected} />
            ) : (
              <EmptyState title="Pick a player">
                Choose a player from the list to see their ratings and recent matches.
              </EmptyState>
            )}
          </div>
        }
      />
    </section>
  )
}

function PlayerPicker({
  scenario,
}: {
  scenario: ListScenario
}) {
  const { data, error, refetch, isFetching } = useQuery(playersQuery(scenario))
  return (
    <div className="split-players__list">
      <h1 className="h2">Players</h1>
      {error ? (
        <LoadFailure
          error={error}
          subject="the players"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !data ? (
        <Loading label="Loading players">
          <ul className="fm-list">
            {Array.from({ length: SKELETON_ROWS }, (_, row) => (
              <li key={row} className="pick-row">
                <span className="fm-skeleton bone-avatar" />
                <Bone w={`${45 + ((row * 19) % 40)}%`} />
              </li>
            ))}
          </ul>
        </Loading>
      ) : data.length === 0 ? (
        <NoPlayers />
      ) : (
        <ul className="fm-list" aria-label="Players">
          {data.map((player) => (
            <li key={player.id}>
              <Link
                to="/players/$variant/$playerId"
                params={{ variant: 'split', playerId: player.id }}
                className="pick-row pick-row--link"
                activeOptions={{ exact: true, includeSearch: false }}
              >
                <Avatar player={player} />
                <span className="pick-row__name">{player.displayName}</span>
                <span className="meta">{leagueCount(player)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PlayerPane({ playerId, scenario }: { playerId: string; scenario: DetailScenario }) {
  const { data: player, error, refetch, isFetching } = useQuery(playerQuery(playerId, scenario))
  const back = (
    <Link
      to="/players/$variant"
      params={{ variant: 'split' }}
      activeOptions={{ exact: true }}
      className="back-link split-players__back"
    >
      <Icon name="left" />
      Players
    </Link>
  )
  if (isNotFound(error)) {
    return (
      <>
        {back}
        <PlayerNotFound variant="split" compact />
      </>
    )
  }
  return (
    <>
      {back}
      {error ? (
        <LoadFailure
          error={error}
          subject="this player"
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : !player ? (
        <Loading label="Loading player">
          <div className="player-hero">
            <span className="fm-skeleton bone-avatar bone-avatar--lg" />
            <div className="player-hero__text">
              <Bone w="220px" h="28px" />
              <Bone w="140px" />
            </div>
          </div>
          <div className="fm-dl bone-dl">
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i}>
                <Bone w="60px" h="12px" />
                <Bone w="80px" h="20px" />
              </div>
            ))}
          </div>
          <div className="bone-rows">
            {Array.from({ length: 3 }, (_, i) => (
              <Bone key={i} h="20px" />
            ))}
          </div>
        </Loading>
      ) : (
        <article className="split-players__player" aria-label={player.displayName}>
          <div className="player-hero">
            <Avatar player={player} large />
            <div className="player-hero__text">
              <h2 className="h2">{player.displayName}</h2>
              <p className="player-hero__meta">
                <KindTag player={player} />
                {player.club && <span>{player.club}</span>}
              </p>
            </div>
          </div>
          {player.standings.length === 0 ? (
            <>
              <NoLeagues player={player} />
              <NoMatches player={player} />
            </>
          ) : (
            <Tabs
              key={player.id}
              label="Leagues"
              panelStyle={{ display: 'flex', flexDirection: 'column', gap: 'var(--s-5)', paddingTop: 'var(--s-5)' }}
              tabs={player.standings.map((standing) => ({
                label: standing.league.name,
                panel: <LeaguePanel player={player} standing={standing} />,
              }))}
            />
          )}
        </article>
      )}
    </>
  )
}

function LeaguePanel({ player, standing }: { player: Player; standing: Standing }) {
  const matches = player.matches.filter((match) => match.league.id === standing.league.id)
  return (
    <>
      <DetailList
        details={[
          { term: 'Place', value: `${ordinal(standing.place)} of ${standing.of}` },
          { term: 'Rating', value: standing.rating, numeric: true },
          { term: 'Won–lost', value: <Record {...standing} />, numeric: true },
          { term: 'Win rate', value: `${winRate(standing)}%`, numeric: true },
        ]}
      />
      <h3 className="fm-section-title">Recent matches in this league</h3>
      {matches.length === 0 ? (
        <NoMatches player={player} />
      ) : (
        <ul className="fm-list fm-list--divided">
          {matches.map((match) => (
            <MatchLine key={match.id} match={match} />
          ))}
        </ul>
      )}
    </>
  )
}

function MatchLine({ match }: { match: MatchResult }) {
  const won = match.games[0] > match.games[1]
  return (
    <li className="match-line">
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
          params={{ variant: 'split', playerId: match.opponentId }}
          className="player-link"
        >
          {match.opponentName}
        </Link>
        <small>{formatDate(match.playedOn)}</small>
      </span>
      <RatingChange change={match.ratingChange} />
    </li>
  )
}
