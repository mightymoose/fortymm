import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQueries } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { startTransition, useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Permission } from '../../api/permissions'
import {
  adminAccountsQuery,
  adminRolesQuery,
  setAccountRoles,
  type AdminAccount,
  type AdminRole,
} from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { FormSheet } from './FormSheet'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'
import { useAdminWrite, useCan } from './useAdminWrite'

const searchSchema = z.object({ email: z.string().trim() })
const accountRolesSchema = z.object({ roleIds: z.array(z.string()) })

// The verified accounts, found by email, each with the roles it holds. With
// `account_roles.manage`, the visitor can change an account's roles.
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
  // The roles name each account's role chips, and the form lists them.
  const [
    {
      data: { accounts, hasMore },
    },
    { data: roles },
  ] = useSuspenseQueries({ queries: [adminAccountsQuery(api, email), adminRolesQuery(api)] })
  const manage = useCan(Permission.accountRolesManage)
  const [editing, setEditing] = useState<AdminAccount | null>(null)
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
              {manage && (
                <th>
                  <span className="fm-sr">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {accounts.map((account) => (
              <tr key={account.id}>
                <td>
                  <span className="admin-name">{account.email}</span>
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
                {manage && (
                  <td className="admin-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Edit roles of ${account.email}`}
                      onClick={() => setEditing(account)}
                    >
                      Edit roles
                    </Button>
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
          <span>Showing the first 50. Search by email to find another account.</span>
        </p>
      )}
      {editing && (
        <AccountRolesSheet account={editing} roles={roles} onClose={() => setEditing(null)} />
      )}
    </>
  )
}

// Sets which roles `account` holds.
function AccountRolesSheet({
  account,
  roles,
  onClose,
}: {
  account: AdminAccount
  roles: readonly AdminRole[]
  onClose: () => void
}) {
  const showToast = useToast()
  const [failure, setFailure] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const save = useAdminWrite(setAccountRoles)
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm({
    resolver: zodResolver(accountRolesSchema),
    defaultValues: { roleIds: account.role_ids },
  })

  const onSubmit = handleSubmit(async ({ roleIds }) => {
    setFailure(null)
    try {
      await save.mutateAsync({ accountId: account.id, roleIds })
    } catch (error) {
      setFailure(error)
      return
    }
    showToast(`Roles saved for ${account.email}`)
    setSaved(true)
  })

  return (
    <FormSheet
      title="Edit roles"
      subtitle={account.email}
      submitLabel="Save roles"
      submitting={isSubmitting}
      saved={saved}
      failure={failure}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      {roles.length === 0 ? (
        <p className="fm-notice">
          <Icon name="info" />
          <span>There are no roles yet. Add one on the Roles tab.</span>
        </p>
      ) : (
        <fieldset className="fm-choices">
          <legend>Roles</legend>
          {roles.map((role) => (
            <label key={role.id} className="fm-check admin-check">
              <input type="checkbox" value={role.id} {...register('roleIds')} />
              <span className="admin-check__text">
                <span>{role.name}</span>
                {role.description && <span className="admin-desc">{role.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </FormSheet>
  )
}
