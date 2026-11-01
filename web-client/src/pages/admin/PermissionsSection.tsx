import { zodResolver } from '@hookform/resolvers/zod'
import { useSuspenseQuery } from '@tanstack/react-query'
import { useRouteContext } from '@tanstack/react-router'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { ApiError } from '../../api/errors'
import { Permission } from '../../api/permissions'
import {
  adminPermissionsQuery,
  createPermission,
  deletePermission,
  updatePermission,
  type AdminPermission,
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

const description = z.string().trim().max(500, 'Use 500 characters or fewer.')

// The API's rules for a permission. Its key never changes, so only a new
// permission has one.
const newPermissionSchema = z.object({
  key: z
    .string()
    .trim()
    .min(1, 'Enter a key.')
    .max(64, 'Use 64 characters or fewer.')
    .regex(
      /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/,
      'Use lowercase words of letters, digits and _, joined by dots, such as games.record.',
    ),
  description,
})
const permissionSchema = z.object({ description })

// The permissions, each with how many roles grant it. With `roles.manage`,
// the visitor can add them, edit their descriptions, and delete the ones
// that aren't built in.
export function PermissionsSection() {
  return (
    <QueryBoundary skeleton={<TableSkeleton label="Loading permissions" />}>
      <Permissions />
    </QueryBoundary>
  )
}

type Editing = { permission: AdminPermission | null } | null

function Permissions() {
  const { api } = useRouteContext({ from: '__root__' })
  const { data: permissions } = useSuspenseQuery(adminPermissionsQuery(api))
  const manage = useCan(Permission.rolesManage)
  const [editing, setEditing] = useState<Editing>(null)
  const [deleting, setDeleting] = useState<AdminPermission | null>(null)

  return (
    <div className="admin-section">
      <div className="admin-toolbar">
        <p className="admin-lead">
          Code checks a permission by its key. Built-in permissions are the ones FortyMM checks
          today, so they stay.
        </p>
        {manage && (
          <Button variant="primary" onClick={() => setEditing({ permission: null })}>
            <Icon name="plus" />
            New permission
          </Button>
        )}
      </div>
      {permissions.length === 0 ? (
        <EmptyState title="No permissions yet">Roles grant permissions to accounts.</EmptyState>
      ) : (
        <div className="admin-table-wrap">
          <table className="fm-table admin-table">
            <thead>
              <tr>
                <th>Key</th>
                <th>Description</th>
                <th className="n">Roles</th>
                {manage && (
                  <th>
                    <span className="fm-sr">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {permissions.map((permission) => (
                <tr key={permission.key}>
                  <td>
                    <span className="admin-check__key">
                      <span className="admin-key admin-name">{permission.key}</span>
                      {permission.built_in && <span className="fm-tag">Built in</span>}
                    </span>
                  </td>
                  <td>{permission.description}</td>
                  <td className="n">{permission.role_count}</td>
                  {manage && (
                    <td className="admin-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Edit ${permission.key}`}
                        onClick={() => setEditing({ permission })}
                      >
                        Edit
                      </Button>
                      {!permission.built_in && (
                        <Button
                          variant="danger"
                          size="sm"
                          aria-label={`Delete ${permission.key}`}
                          onClick={() => setDeleting(permission)}
                        >
                          Delete…
                        </Button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing &&
        (editing.permission ? (
          <EditPermission permission={editing.permission} onClose={() => setEditing(null)} />
        ) : (
          <NewPermission onClose={() => setEditing(null)} />
        ))}
      {deleting && <DeletePermission permission={deleting} onClose={() => setDeleting(null)} />}
    </div>
  )
}

function NewPermission({ onClose }: { onClose: () => void }) {
  const showToast = useToast()
  const [failure, setFailure] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const create = useAdminWrite(createPermission)
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(newPermissionSchema),
    defaultValues: { key: '', description: '' },
  })

  const onSubmit = handleSubmit(async (draft) => {
    setFailure(null)
    try {
      await create.mutateAsync(draft)
    } catch (error) {
      // A new permission's only 409 is a key that another one has.
      if (error instanceof ApiError && error.status === 409) {
        setError('key', { message: 'Another permission has this key.' }, { shouldFocus: true })
      } else {
        setFailure(error)
      }
      return
    }
    showToast('Permission created')
    setSaved(true)
  })

  return (
    <FormSheet
      title="New permission"
      subtitle="Roles grant it. It does nothing until code checks its key."
      submitLabel="Create permission"
      submitting={isSubmitting}
      saved={saved}
      failure={failure}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <TextField
        label="Key"
        help="Lowercase words joined by dots, such as games.record. It can’t change later."
        autoComplete="off"
        spellCheck={false}
        error={errors.key?.message}
        registration={register('key')}
      />
      <TextField
        label="Description"
        optional
        multiline
        error={errors.description?.message}
        registration={register('description')}
      />
    </FormSheet>
  )
}

function EditPermission({
  permission,
  onClose,
}: {
  permission: AdminPermission
  onClose: () => void
}) {
  const showToast = useToast()
  const [failure, setFailure] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const update = useAdminWrite(updatePermission)
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(permissionSchema),
    defaultValues: { description: permission.description },
  })

  const onSubmit = handleSubmit(async ({ description }) => {
    setFailure(null)
    try {
      await update.mutateAsync({ key: permission.key, description })
    } catch (error) {
      setFailure(error)
      return
    }
    showToast('Permission saved')
    setSaved(true)
  })

  return (
    <FormSheet
      title={`Edit ${permission.key}`}
      subtitle="The key can’t change, because code checks it."
      submitLabel="Save permission"
      submitting={isSubmitting}
      saved={saved}
      failure={failure}
      onSubmit={onSubmit}
      onClose={onClose}
    >
      <TextField
        label="Description"
        optional
        multiline
        error={errors.description?.message}
        registration={register('description')}
      />
    </FormSheet>
  )
}

function DeletePermission({
  permission,
  onClose,
}: {
  permission: AdminPermission
  onClose: () => void
}) {
  const showToast = useToast()
  const remove = useAdminWrite(deletePermission)
  const roles =
    permission.role_count === 1 ? '1 role grants it.' : `${permission.role_count} roles grant it.`
  return (
    <ConfirmDialog
      title={`Delete ${permission.key}?`}
      confirmLabel="Delete permission"
      onConfirm={async () => {
        await remove.mutateAsync(permission.key)
        showToast('Permission deleted')
      }}
      onClose={onClose}
    >
      <p>{roles} Every role loses it. This can’t be undone.</p>
    </ConfirmDialog>
  )
}
