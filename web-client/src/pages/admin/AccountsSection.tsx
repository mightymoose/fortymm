import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQueries } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import {
  adminAccountsQuery,
  adminRolesQuery,
  isVerified,
  type AccountView,
  type AdminAccount,
} from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { SegmentedControl } from '../../components/SegmentedControl'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'

type ViewCopy = {
  label: string
  empty: { title: string; body: string }
  noMatch: string
  more: string
}

// In the order the control shows them. The first is the default.
const VIEWS = {
  verified: {
    label: 'Verified',
    empty: { title: 'No verified accounts yet', body: 'An account shows here once it signs in.' },
    noMatch: 'No verified account’s email or player name contains',
    more: 'Showing the first 50. Search by email or player name to find another account.',
  },
  guests: {
    label: 'Guests',
    empty: { title: 'No guests', body: 'A visitor who plays without signing in shows here.' },
    noMatch: 'No guest’s player name contains',
    more: 'Showing the 50 seen longest ago. Search by player name to find another guest.',
  },
  all: {
    label: 'All',
    empty: { title: 'No accounts yet', body: 'An account shows here once someone plays.' },
    noMatch: 'No account’s email or player name contains',
    more: 'Showing the 50 seen longest ago. Search by email or player name to find another account.',
  },
} satisfies Record<AccountView, ViewCopy>
const VIEW_ORDER = Object.keys(VIEWS) as AccountView[]

const searchSchema = z.object({ search: z.string().trim() })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

// The accounts, verified ones, guests or both, found by email or player
// name, each with the roles it holds. Each links to the account's own page.
export function AccountsSection() {
  const [view, setView] = useState<AccountView>(VIEW_ORDER[0])
  const [search, setSearch] = useState('')
  const { register, handleSubmit } = useForm({
    resolver: zodResolver(searchSchema),
    defaultValues: { search: '' },
  })
  // In a transition, so the list from before stays while the new one loads.
  const onSubmit = handleSubmit(({ search }) => startTransition(() => setSearch(search)))
  const onView = (label: string) => {
    const next = VIEW_ORDER.find((id) => VIEWS[id].label === label)
    if (next) startTransition(() => setView(next))
  }

  return (
    <div className="admin-section">
      <SegmentedControl
        label="Accounts to show"
        options={VIEW_ORDER.map((id) => VIEWS[id].label)}
        onChange={onView}
      />
      <form role="search" className="admin-search" noValidate onSubmit={onSubmit}>
        <TextField
          label="Email or player name"
          type="search"
          autoComplete="off"
          spellCheck={false}
          help="Finds the accounts whose email or player name contains it."
          registration={register('search')}
        />
        <Button variant="secondary" type="submit">
          <Icon name="search" />
          Search
        </Button>
      </form>
      <QueryBoundary skeleton={<TableSkeleton label="Loading accounts" />}>
        <Accounts view={view} search={search} />
      </QueryBoundary>
    </div>
  )
}

function Accounts({ view, search }: { view: AccountView; search: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  // The roles name each account's role chips.
  const [
    {
      data: { accounts, hasMore },
    },
    { data: roles },
  ] = useSuspenseQueries({
    queries: [adminAccountsQuery(api, view, search), adminRolesQuery(api)],
  })
  const names = new Map(roles.map((role) => [role.id, role.name]))
  const copy = VIEWS[view]

  if (accounts.length === 0) {
    return search ? (
      <EmptyState title="No accounts match">
        {copy.noMatch} “{search}”.
      </EmptyState>
    ) : (
      <EmptyState title={copy.empty.title}>{copy.empty.body}</EmptyState>
    )
  }
  return (
    <>
      <div className="admin-table-wrap">
        <table className="fm-table admin-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Roles</th>
              <th className="n">Matches</th>
              <th>Last seen</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <AccountCell account={account} />
                </td>
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
                <td className="n">{account.match_count}</td>
                <td>
                  <Day iso={account.last_seen_at} />
                </td>
                <td>
                  <Day iso={account.created_at} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <p className="fm-notice">
          <Icon name="info" />
          <span>{copy.more}</span>
        </p>
      )}
    </>
  )
}

function AccountCell({ account }: { account: AdminAccount }) {
  const link = (text: string) => (
    <Link to="/admin/accounts/$accountId" params={{ accountId: account.id }}>
      {text}
    </Link>
  )
  if (isVerified(account)) {
    return (
      <>
        <span className="admin-name">{link(account.email)}</span>
        <span className="admin-desc">{account.display_name ?? 'No player yet'}</span>
      </>
    )
  }
  return (
    <span className="admin-check__key">
      <span className="admin-name">{link(account.display_name ?? 'No player yet')}</span>
      <span className="fm-tag">Guest</span>
    </span>
  )
}

function Day({ iso }: { iso: string }) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>
}
