import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQueries } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { adminAccountsQuery, adminRolesQuery } from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'

const searchSchema = z.object({ email: z.string().trim() })

// The verified accounts, found by email, each with the roles it holds. Each
// email links to the account's own page, where its roles change.
export function AccountsSection() {
  const [email, setEmail] = useState('')
  const { register, handleSubmit } = useForm({
    resolver: zodResolver(searchSchema),
    defaultValues: { email: '' },
  })
  // In a transition, so the list from before stays while the new one loads.
  const onSubmit = handleSubmit(({ email }) => startTransition(() => setEmail(email)))

  return (
    <div className="admin-section">
      <form role="search" className="admin-search" noValidate onSubmit={onSubmit}>
        <TextField
          label="Email"
          type="search"
          autoComplete="off"
          spellCheck={false}
          help="Finds the accounts whose email contains it."
          registration={register('email')}
        />
        <Button variant="secondary" type="submit">
          <Icon name="search" />
          Search
        </Button>
      </form>
      <QueryBoundary skeleton={<TableSkeleton label="Loading accounts" />}>
        <Accounts email={email} />
      </QueryBoundary>
    </div>
  )
}

function Accounts({ email }: { email: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  // The roles name each account's role chips.
  const [
    {
      data: { accounts, hasMore },
    },
    { data: roles },
  ] = useSuspenseQueries({ queries: [adminAccountsQuery(api, email), adminRolesQuery(api)] })
  const names = new Map(roles.map((role) => [role.id, role.name]))

  if (accounts.length === 0) {
    return email ? (
      <EmptyState title="No accounts match">
        No verified account’s email contains “{email}”.
      </EmptyState>
    ) : (
      <EmptyState title="No accounts yet">An account shows here once it signs in.</EmptyState>
    )
  }
  return (
    <>
      <div className="admin-table-wrap">
        <table className="fm-table admin-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Player</th>
              <th>Roles</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <span className="admin-name">
                    <Link to="/admin/accounts/$accountId" params={{ accountId: account.id }}>
                      {account.email}
                    </Link>
                  </span>
                </td>
                <td>{account.display_name ?? <span className="meta">None yet</span>}</td>
                <td>
                  <span className="admin-tags">
                    {account.role_ids.length === 0 && <span className="meta">None</span>}
                    {account.role_ids.map((id) => (
                      <span key={id} className="fm-tag">
                        {names.get(id) ?? 'Unknown role'}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <p className="fm-notice">
          <Icon name="info" />
          <span>Showing the first 50. Search by email to find another account.</span>
        </p>
      )}
    </>
  )
}
