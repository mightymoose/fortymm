import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { adminPlayersQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'

const searchSchema = z.object({ name: z.string().trim() })

// Every player that no merge replaced, found by display name, each with the
// account that plays as it and how many accounts manage it. Each name links
// to the player's own page.
export function PlayersSection() {
  const [name, setName] = useState('')
  const { register, handleSubmit } = useForm({
    resolver: zodResolver(searchSchema),
    defaultValues: { name: '' },
  })
  // In a transition, so the list from before stays while the new one loads.
  const onSubmit = handleSubmit(({ name }) => startTransition(() => setName(name)))

  return (
    <div className="admin-section">
      <form role="search" className="admin-search" noValidate onSubmit={onSubmit}>
        <TextField
          label="Name"
          type="search"
          autoComplete="off"
          spellCheck={false}
          help="Finds the players whose name contains it."
          registration={register('name')}
        />
        <Button variant="secondary" type="submit">
          <Icon name="search" />
          Search
        </Button>
      </form>
      <QueryBoundary skeleton={<TableSkeleton label="Loading players" />}>
        <Players name={name} />
      </QueryBoundary>
    </div>
  )
}

function Players({ name }: { name: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  const {
    data: { players, hasMore },
  } = useSuspenseQuery(adminPlayersQuery(api, name))

  if (players.length === 0) {
    return name ? (
      <EmptyState title="No players match">No player’s name contains “{name}”.</EmptyState>
    ) : (
      <EmptyState title="No players yet">A player shows here once someone plays or adds one.</EmptyState>
    )
  }
  return (
    <>
      <div className="admin-table-wrap">
        <table className="fm-table admin-table">
          <thead>
            <tr>
              <th>Player</th>
              <th>Account</th>
              <th>Managers</th>
            </tr>
          </thead>
          <tbody>
            {players.map((player) => (
              <tr key={player.id}>
                <td>
                  <span className="admin-name">
                    <Link to="/admin/players/$playerId" params={{ playerId: player.id }}>
                      {player.display_name}
                    </Link>
                  </span>
                </td>
                <td>
                  {player.account_id === null ? (
                    <span className="meta">None</span>
                  ) : player.account_email === null ? (
                    'Guest'
                  ) : (
                    <Link to="/admin/accounts/$accountId" params={{ accountId: player.account_id }}>
                      {player.account_email}
                    </Link>
                  )}
                </td>
                <td className="admin-key">{player.manager_count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <p className="fm-notice">
          <Icon name="info" />
          <span>Showing the first 50. Search by name to find another player.</span>
        </p>
      )}
    </>
  )
}
