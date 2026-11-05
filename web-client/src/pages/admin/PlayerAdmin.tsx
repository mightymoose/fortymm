import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useParams, useRouteContext } from '@tanstack/react-router'
import { adminPlayerQuery, type AdminPlayerDetail } from '../../api/queries'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import './admin.css'

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

// One player's admin page, for accounts with `admin.view`: who the player
// is, the accounts that play as it or manage it, and its leagues. A merged
// player's page links to the player it merged into.
export function PlayerAdmin() {
  const { playerId } = useParams({ from: '/_authenticated/_shell/admin/players/$playerId' })
  return (
    <div className="admin">
      <nav className="fm-crumbs" aria-label="Breadcrumb">
        <Link to="/admin">Administration</Link>
        <span aria-hidden="true">/</span>
        <Link to="/admin" search={{ tab: 'players' }}>
          Players
        </Link>
      </nav>
      <QueryBoundary skeleton={<PlayerSkeleton />}>
        <Player id={playerId} />
      </QueryBoundary>
    </div>
  )
}

function PlayerSkeleton() {
  return (
    <div className="admin-skeleton" aria-busy="true">
      <span className="fm-sr" role="status">
        Loading player
      </span>
      <div className="fm-skeleton admin-skeleton__title" aria-hidden="true" />
      <div className="fm-skeleton admin-skeleton__bar" aria-hidden="true" />
      <div className="fm-skeleton admin-skeleton__card" aria-hidden="true" />
    </div>
  )
}

function Player({ id }: { id: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: player } = useSuspenseQuery(adminPlayerQuery(api, id))

  if (!player) {
    return (
      <>
        <h1>No such player</h1>
        <EmptyState title="This player isn’t here">
          No player has this address. The link may be wrong. Find the player on the Players tab.
        </EmptyState>
      </>
    )
  }
  return (
    <>
      <h1 className="admin-title">{player.display_name}</h1>
      {player.merged_into !== null && (
        <p className="fm-notice fm-notice--warning">
          <Icon name="info" />
          <span>
            This player merged into{' '}
            <Link to="/admin/players/$playerId" params={{ playerId: player.merged_into }}>
              {player.merged_into_display_name}
            </Link>
            , which stands for it now.
          </span>
        </p>
      )}
      <dl className="fm-dl admin-facts">
        <div>
          <dt>Added</dt>
          <dd>
            <time dateTime={player.created_at}>{dateFormat.format(new Date(player.created_at))}</time>
          </dd>
        </div>
        <div>
          <dt>Matches</dt>
          <dd>{player.match_count}</dd>
        </div>
        <div>
          <dt>Leagues</dt>
          <dd>{player.leagues.length === 0 ? 'None' : player.leagues.join(', ')}</dd>
        </div>
      </dl>
      <Managers player={player} />
    </>
  )
}

function Managers({ player }: { player: AdminPlayerDetail }) {
  return (
    <section className="fm-card" aria-labelledby="player-managers">
      <div className="fm-card__head">
        <div>
          <h2 className="fm-card__title" id="player-managers">
            Accounts
          </h2>
          <p className="fm-card__sub">
            The account that plays as this player, and any that manage it for someone else.
          </p>
        </div>
      </div>
      <div className="fm-card__body">
        {player.managers.length === 0 ? (
          <p className="meta">No account plays as this player or manages it.</p>
        ) : (
          <ul className="fm-list">
            {player.managers.map((manager) => (
              <li key={manager.id}>
                <span className="admin-name">
                  {manager.email === null ? (
                    'Guest'
                  ) : (
                    <Link to="/admin/accounts/$accountId" params={{ accountId: manager.id }}>
                      {manager.email}
                    </Link>
                  )}
                </span>
                <span className="admin-tags">
                  <span className="fm-tag">
                    {manager.relationship === 'self' ? 'Plays as' : 'Manages'}
                  </span>
                  {manager.open_question && (
                    <span className="fm-tag fm-tag--outline">Hasn’t answered “Is this you?”</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
