import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useRouteContext } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Permission } from '../../api/permissions'
import { adminSigningKeysQuery, revokeSigningKey, type AdminSigningKey } from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { ConfirmDialog } from './ConfirmDialog'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'
import { useAdminWrite, useCan } from './useAdminWrite'

const searchSchema = z.object({ search: z.string().trim() })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })

export function SigningKeysSection() {
  const [search, setSearch] = useState('')
  const { register, handleSubmit } = useForm({
    resolver: zodResolver(searchSchema),
    defaultValues: { search: '' },
  })
  // In a transition, so the list from before stays while the new one loads.
  const onSubmit = handleSubmit(({ search }) => startTransition(() => setSearch(search)))

  return (
    <div className="admin-section">
      <p className="admin-lead">
        Each device signs match results with its own key. Revoke a key when its device may be in
        the wrong hands. FortyMM then refuses what the key signs, for good.
      </p>
      <form role="search" className="admin-search" noValidate onSubmit={onSubmit}>
        <TextField
          label="Account"
          type="search"
          autoComplete="off"
          spellCheck={false}
          help="Finds the keys whose account’s email or player name contains it."
          registration={register('search')}
        />
        <Button variant="secondary" type="submit">
          <Icon name="search" />
          Search
        </Button>
      </form>
      <QueryBoundary skeleton={<TableSkeleton label="Loading signing keys" />}>
        <SigningKeys search={search} />
      </QueryBoundary>
    </div>
  )
}

function SigningKeys({ search }: { search: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  const {
    data: { keys, hasMore },
  } = useSuspenseQuery(adminSigningKeysQuery(api, search))
  const canRevoke = useCan(Permission.signingKeysRevoke)
  const [revoking, setRevoking] = useState<AdminSigningKey | null>(null)

  if (keys.length === 0) {
    return search ? (
      <EmptyState title="No signing keys match">
        No account’s email or player name contains “{search}”.
      </EmptyState>
    ) : (
      <EmptyState title="No signing keys yet">
        A device registers its key the first time it opens FortyMM.
      </EmptyState>
    )
  }
  return (
    <>
      <div className="admin-table-wrap">
        <table className="fm-table admin-table">
          <thead>
            <tr>
              <th>Device</th>
              <th>Account</th>
              <th>Registered</th>
              <th>State</th>
              {canRevoke && (
                <th>
                  <span className="fm-sr">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => (
              <tr key={key.id}>
                <td>
                  <span className="admin-name">{key.label}</span>
                  <span className="admin-desc admin-key" title={key.id}>
                    {shortKid(key.id)}…
                  </span>
                </td>
                <td>
                  <KeyAccountCell account={key.account} />
                </td>
                <td>
                  <Day iso={key.created_at} />
                </td>
                <td>
                  <KeyStateCell signingKey={key} />
                </td>
                {canRevoke && (
                  <td className="admin-actions">
                    {key.state !== 'revoked' && (
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Revoke key ${shortKid(key.id)}`}
                        onClick={() => setRevoking(key)}
                      >
                        Revoke…
                      </Button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <p className="fm-notice">
          <Icon name="info" />
          <span>Showing the newest 50. Search by account to find another key.</span>
        </p>
      )}
      {revoking && <RevokeKey signingKey={revoking} onClose={() => setRevoking(null)} />}
    </>
  )
}

function KeyAccountCell({ account }: { account: AdminSigningKey['account'] }) {
  return (
    <>
      {account.email ? (
        <span className="admin-name">
          <Link to="/admin/accounts/$accountId" params={{ accountId: account.id }}>
            {account.email}
          </Link>
        </span>
      ) : (
        <span className="fm-tag">Guest</span>
      )}
      <span className="admin-desc">{account.display_name ?? 'No player yet'}</span>
    </>
  )
}

function KeyStateCell({ signingKey: key }: { signingKey: AdminSigningKey }) {
  switch (key.state) {
    case 'live':
      return (
        <span className="fm-status">
          <Icon name="check" />
          Live
        </span>
      )
    case 'signed_out':
      return (
        <>
          <span className="fm-status fm-status--offline">Signed out</span>
          {key.signed_out_at && (
            <span className="admin-desc">
              <Day iso={key.signed_out_at} />
            </span>
          )}
        </>
      )
    case 'revoked':
      return (
        <>
          <span className="fm-status fm-status--danger">
            <Icon name="error" />
            Revoked
          </span>
          {key.revoked_at && (
            <span className="admin-desc">
              <Day iso={key.revoked_at} />{' '}
              by {key.revoked_by === key.account.id ? 'the owner' : key.revoked_by_email}
            </span>
          )}
        </>
      )
  }
}

function Day({ iso }: { iso: string }) {
  return <time dateTime={iso}>{dateFormat.format(new Date(iso))}</time>
}

function shortKid(id: string): string {
  return id.slice(0, 8)
}

function RevokeKey({ signingKey: key, onClose }: { signingKey: AdminSigningKey; onClose: () => void }) {
  const showToast = useToast()
  const revoke = useAdminWrite(revokeSigningKey)
  return (
    <ConfirmDialog
      title="Revoke this signing key?"
      confirmLabel="Revoke key"
      busyLabel="Revoking…"
      onConfirm={async () => {
        await revoke.mutateAsync(key.id)
        showToast('Signing key revoked')
      }}
      onClose={onClose}
    >
      <dl className="fm-dl">
        <div>
          <dt>Device</dt>
          <dd>{key.label}</dd>
        </div>
        <div>
          <dt>Account</dt>
          <dd>{key.account.email ?? 'Guest'}</dd>
        </div>
        <div>
          <dt>Player</dt>
          <dd>{key.account.display_name ?? 'No player yet'}</dd>
        </div>
        <div>
          <dt>Registered</dt>
          <dd>
            <Day iso={key.created_at} />
          </dd>
        </div>
      </dl>
      <p>
        FortyMM will refuse every result this key signs from now on, and every result it signed
        that hasn’t reached FortyMM yet. Results FortyMM already has stay as they are.
      </p>
      <p>The device stays signed in. The next time it opens FortyMM online, it makes a new key.</p>
      <p>This can’t be undone.</p>
    </ConfirmDialog>
  )
}
