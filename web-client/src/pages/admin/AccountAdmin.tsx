import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import { Link, useParams, useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Permission } from '../../api/permissions'
import { adminAccountQuery, setAccountRoles, type AdminAccountDetail } from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { useAdminWrite, useCan } from './useAdminWrite'
import { WriteError } from './WriteError'
import './admin.css'

const accountRolesSchema = z.object({ roleIds: z.array(z.string()) })
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' })
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

// One verified account's admin page, for accounts with `admin.view`: who it
// is, and which roles it holds. With `account_roles.manage`, the visitor
// sets its roles here.
export function AccountAdmin() {
  const { accountId } = useParams({ from: '/_authenticated/_shell/admin/accounts/$accountId' })
  return (
    <div className="admin">
      <nav className="fm-crumbs" aria-label="Breadcrumb">
        <Link to="/admin">Administration</Link>
        <span aria-hidden="true">/</span>
        <Link to="/admin" search={{ tab: 'accounts' }}>
          Accounts
        </Link>
      </nav>
      <QueryBoundary skeleton={<AccountSkeleton />}>
        <Account id={accountId} />
      </QueryBoundary>
    </div>
  )
}

function AccountSkeleton() {
  return (
    <div className="admin-skeleton" aria-busy="true">
      <span className="fm-sr" role="status">
        Loading account
      </span>
      <div className="fm-skeleton admin-skeleton__title" aria-hidden="true" />
      <div className="fm-skeleton admin-skeleton__bar" aria-hidden="true" />
      <div className="fm-skeleton admin-skeleton__card" aria-hidden="true" />
    </div>
  )
}

function Account({ id }: { id: string }) {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: account } = useSuspenseQuery(adminAccountQuery(api, id))

  if (!account) {
    return (
      <>
        <h1>No such account</h1>
        <EmptyState title="This account isn’t here">
          No verified account has this address. It may have been a guest, or the link may be
          wrong. Find the account on the Accounts tab.
        </EmptyState>
      </>
    )
  }
  return (
    <>
      <h1 className="admin-title">{account.email}</h1>
      <dl className="fm-dl admin-facts">
        <div>
          <dt>Player</dt>
          <dd>{account.display_name ?? 'None yet'}</dd>
        </div>
        <div>
          <dt>Joined</dt>
          <dd>
            <time dateTime={account.created_at}>{dateFormat.format(new Date(account.created_at))}</time>
          </dd>
        </div>
        <div>
          <dt>Last seen</dt>
          <dd>
            <time dateTime={account.last_seen_at}>
              {dateTimeFormat.format(new Date(account.last_seen_at))}
            </time>
          </dd>
        </div>
      </dl>
      <AccountRoles account={account} />
    </>
  )
}

function AccountRoles({ account }: { account: AdminAccountDetail }) {
  const manage = useCan(Permission.accountRolesManage)
  const held = account.roles.filter((role) => role.held)
  return (
    <section className="fm-card" aria-labelledby="account-roles">
      <div className="fm-card__head">
        <div>
          <h2 className="fm-card__title" id="account-roles">
            Roles
          </h2>
          <p className="fm-card__sub">The account may do what its roles’ permissions let it.</p>
        </div>
      </div>
      {account.roles.length === 0 ? (
        <div className="fm-card__body">
          <p className="fm-notice">
            <Icon name="info" />
            <span>There are no roles yet. Add one on the Roles tab.</span>
          </p>
        </div>
      ) : manage ? (
        // Keyed by what it holds, so the form starts again from the saved
        // roles when another tab changes them.
        <RolesForm key={held.map((role) => role.id).join()} account={account} />
      ) : (
        <div className="fm-card__body">
          {held.length === 0 ? (
            <p className="meta">Holds no role.</p>
          ) : (
            <ul className="fm-list">
              {held.map((role) => (
                <li key={role.id}>
                  <span className="admin-name">{role.name}</span>
                  {role.description && <span className="admin-desc">{role.description}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}

// Sets which roles the account holds.
function RolesForm({ account }: { account: AdminAccountDetail }) {
  const showToast = useToast()
  const [failure, setFailure] = useState<unknown>(null)
  const save = useAdminWrite(setAccountRoles)
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm({
    resolver: zodResolver(accountRolesSchema),
    defaultValues: { roleIds: account.roles.filter((role) => role.held).map((role) => role.id) },
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
  })

  return (
    <form noValidate onSubmit={onSubmit}>
      <div className="fm-card__body admin-form">
        {failure != null && <WriteError error={failure} />}
        <fieldset className="fm-choices">
          <legend className="fm-sr">Roles</legend>
          {account.roles.map((role) => (
            <label key={role.id} className="fm-check admin-check">
              <input type="checkbox" value={role.id} {...register('roleIds')} />
              <span className="admin-check__text">
                <span>{role.name}</span>
                {role.description && <span className="admin-desc">{role.description}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <div className="fm-card__foot">
        <Button variant="primary" type="submit" busy={isSubmitting} disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save roles'}
        </Button>
      </div>
    </form>
  )
}
