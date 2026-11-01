import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQueries } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { ApiError } from '../../api/errors'
import { Permission } from '../../api/permissions'
import {
  adminPermissionsQuery,
  adminRolesQuery,
  createRole,
  deleteRole,
  updateRole,
  type AdminPermission,
  type AdminRole,
  type RoleDraft,
} from '../../api/queries'
import { Button } from '../../components/Button'
import { EmptyState } from '../../components/EmptyState'
import { Icon } from '../../components/Icon'
import { QueryBoundary } from '../../components/QueryBoundary'
import { useToast } from '../../components/toastContext'
import { ConfirmDialog } from './ConfirmDialog'
import { FormSheet } from './FormSheet'
import { TableSkeleton } from './TableSkeleton'
import { TextField } from './TextField'
import { useAdminWrite, useCan } from './useAdminWrite'

// The API's title for a 409 to a role whose name another role has. A role
// update can also get a 409 when no account would keep the permission to
// grant roles, so the title tells them apart.
const NAME_TAKEN = 'Another role has this name'

// The API's rules for a role, so the form shows a mistake before it sends.
const roleSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name.').max(50, 'Use 50 characters or fewer.'),
  description: z.string().trim().max(500, 'Use 500 characters or fewer.'),
  permissions: z.array(z.string()),
})

// The roles, each with its permissions and how many accounts hold it. With
// `roles.manage`, the visitor can add, edit and delete them.
export function RolesSection() {
  return (
    <QueryBoundary skeleton={<TableSkeleton label="Loading roles" />}>
      <Roles />
    </QueryBoundary>
  )
}

type Editing = { role: AdminRole | null } | null

function Roles() {
  const { api } = useRouteContext({ from: '__root__' })
  // The form lists every permission, so the permissions load with the roles.
  const [{ data: roles }, { data: permissions }] = useSuspenseQueries({
    queries: [adminRolesQuery(api), adminPermissionsQuery(api)],
  })
  const manage = useCan(Permission.rolesManage)
  const [editing, setEditing] = useState<Editing>(null)
  const [deleting, setDeleting] = useState<AdminRole | null>(null)

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <p className="admin-lead">A role is a named set of permissions. Accounts hold roles.</p>
        {manage && (
          <Button variant="primary" onClick={() => setEditing({ role: null })}>
            <Icon name="plus" />
            New role
          </Button>
        )}
      </div>
      {roles.length === 0 ? (
        <EmptyState title="No roles yet">A role gives the accounts that hold it its permissions.</EmptyState>
      ) : (
        <div className="admin-table-wrap">
          <table className="fm-table admin-table">
            <thead>
              <tr>
                <th>Role</th>
                <th>Permissions</th>
                <th className="n">Accounts</th>
                {manage && (
                  <th>
                    <span className="fm-sr">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {roles.map((role) => (
                <tr key={role.id}>
                  <td>
                    <span className="admin-name">{role.name}</span>
                    {role.description && <span className="admin-desc">{role.description}</span>}
                  </td>
                  <td>
                    <span className="admin-tags">
                      {role.permissions.length === 0 && <span className="meta">None</span>}
                      {role.permissions.map((key) => (
                        <span key={key} className="fm-tag admin-key">
                          {key}
                        </span>
                      ))}
                    </span>
                  </td>
                  <td className="n">{role.account_count}</td>
                  {manage && (
                    <td className="admin-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${role.name}`}
                        onClick={() => setEditing({ role })}
                      >
                        Edit
                      </Button>
                      <Button
                        variant="danger"
                        size="sm"
                        aria-label={`Delete ${role.name}`}
                        onClick={() => setDeleting(role)}
                      >
                        Delete…
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <RoleSheet
          role={editing.role}
          permissions={permissions}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteRole role={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}

// Adds a role, or edits `role`: its name, description and permissions.
function RoleSheet({
  role,
  permissions,
  onClose,
}: {
  role: AdminRole | null
  permissions: readonly AdminPermission[]
  onClose: () => void
}) {
  const showToast = useToast()
  const [failure, setFailure] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const save = useAdminWrite((api, draft: RoleDraft) =>
    role ? updateRole(api, { id: role.id, ...draft }) : createRole(api, draft),
  )
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(roleSchema),
    defaultValues: {
      name: role?.name ?? '',
      description: role?.description ?? '',
      permissions: role?.permissions ?? [],
    },
  })

  const onSubmit = handleSubmit(async (draft) => {
    setFailure(null)
    try {
      await save.mutateAsync(draft)
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.title === NAME_TAKEN) {
        setError('name', { message: 'Another role has this name. Choose another.' }, { shouldFocus: true })
      } else {
        setFailure(error)
      }
      return
    }
    showToast(role ? 'Role saved' : 'Role created')
    setSaved(true)
  })

  return (
    <FormSheet
      title={role ? `Edit ${role.name}` : 'New role'}
      subtitle="Accounts that hold the role get its permissions."
      submitLabel={role ? 'Save role' : 'Create role'}
      submitting={isSubmitting}
      saved={saved}
      failure={failure}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <TextField
        label="Name"
        autoComplete="off"
        error={errors.name?.message}
        registration={register('name')}
      />
      <TextField
        label="Description"
        optional
        multiline
        error={errors.description?.message}
        registration={register('description')}
      />
      <fieldset className="fm-choices">
        <legend>Permissions</legend>
        {permissions.map((permission) => (
          <label key={permission.key} className="fm-check admin-check">
            <input type="checkbox" value={permission.key} {...register('permissions')} />
            <span className="admin-check__text">
              <span className="admin-check__key">
                <span className="admin-key">{permission.key}</span>
                {permission.built_in && <span className="fm-tag">Built in</span>}
              </span>
              {permission.description && (
                <span className="admin-desc">{permission.description}</span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
    </FormSheet>
  )
}

function DeleteRole({ role, onClose }: { role: AdminRole; onClose: () => void }) {
  const showToast = useToast()
  const remove = useAdminWrite(deleteRole)
  const holders =
    role.account_count === 1 ? '1 account holds it.' : `${role.account_count} accounts hold it.`
  return (
    <ConfirmDialog
      title={`Delete ${role.name}?`}
      confirmLabel="Delete role"
      onConfirm={async () => {
        await remove.mutateAsync(role.id)
        showToast('Role deleted')
      }}
      onClose={onClose}
    >
      <p>{holders} They lose the permissions it gives. This can’t be undone.</p>
    </ConfirmDialog>
  )
}
