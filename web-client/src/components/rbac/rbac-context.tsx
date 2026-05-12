import { useMemo, useState, type ReactNode } from 'react'
import { PERMISSIONS_SEED, ROLES_SEED, USERS_SEED, type Permission, type Role, type User } from './seed'
import { newId, nowIso } from './helpers'
import { RbacActionsCtx, RbacDataCtx, type RbacActions } from './rbac-context-internal'

export function RbacProvider({ children }: { children: ReactNode }) {
  const [roles, setRoles] = useState<Role[]>(ROLES_SEED)
  const [permissions, setPermissions] = useState<Permission[]>(PERMISSIONS_SEED)
  const [users, setUsers] = useState<User[]>(USERS_SEED)

  const data = useMemo(() => ({ roles, permissions, users }), [roles, permissions, users])

  const actions = useMemo<RbacActions>(() => ({
    createRole({ name, description, templateId }) {
      const id = newId('r')
      setRoles((rs) => {
        const tmpl = templateId ? rs.find((r) => r.id === templateId) : null
        return [...rs, {
          id,
          name,
          description: description || '',
          permission_ids: tmpl ? [...tmpl.permission_ids] : [],
          created_at: nowIso(),
          updated_at: nowIso(),
        }]
      })
      return id
    },
    updateRole(id, patch) {
      setRoles((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch, updated_at: nowIso() } : r)))
    },
    deleteRole(id) {
      setRoles((rs) => rs.filter((r) => r.id !== id))
      setUsers((us) => us.map((u) => ({ ...u, role_ids: u.role_ids.filter((rid) => rid !== id) })))
    },
    duplicateRole(id) {
      let newRoleId: string | null = null
      setRoles((rs) => {
        const src = rs.find((r) => r.id === id)
        if (!src) return rs
        newRoleId = newId('r')
        return [...rs, {
          id: newRoleId,
          name: `${src.name} (copy)`,
          description: src.description || '',
          permission_ids: [...src.permission_ids],
          created_at: nowIso(),
          updated_at: nowIso(),
        }]
      })
      return newRoleId
    },

    createPermission({ name, description }) {
      setPermissions((ps) => [...ps, {
        id: newId('p'),
        name,
        description: description || '',
        created_at: nowIso(),
        updated_at: nowIso(),
      }])
    },
    updatePermission(id, patch) {
      setPermissions((ps) => ps.map((p) => (p.id === id ? { ...p, ...patch, updated_at: nowIso() } : p)))
    },
    deletePermission(id) {
      setPermissions((ps) => ps.filter((p) => p.id !== id))
      setRoles((rs) => rs.map((r) => ({ ...r, permission_ids: r.permission_ids.filter((pid) => pid !== id) })))
    },

    addUser(username) {
      const id = newId('u')
      setUsers((us) => [...us, { id, username, role_ids: [], created_at: nowIso() }])
      return id
    },
    removeUser(id) {
      setUsers((us) => us.filter((u) => u.id !== id))
    },
    setUserRoles(id, role_ids) {
      setUsers((us) => us.map((u) => (u.id === id ? { ...u, role_ids } : u)))
    },
    revokeRoleFromUser(userId, roleId) {
      setUsers((us) =>
        us.map((u) => (u.id === userId ? { ...u, role_ids: u.role_ids.filter((rid) => rid !== roleId) } : u)),
      )
    },
  }), [])

  return (
    <RbacActionsCtx.Provider value={actions}>
      <RbacDataCtx.Provider value={data}>{children}</RbacDataCtx.Provider>
    </RbacActionsCtx.Provider>
  )
}
