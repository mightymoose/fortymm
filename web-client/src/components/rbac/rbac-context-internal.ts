import { createContext } from 'react'
import type { Permission, Role, User } from './seed'

export type RbacData = {
  roles: Role[]
  permissions: Permission[]
  users: User[]
}

export type RbacActions = {
  createRole: (input: { name: string; description: string; templateId?: string }) => string
  updateRole: (id: string, patch: Partial<Pick<Role, 'name' | 'description' | 'permission_ids'>>) => void
  deleteRole: (id: string) => void
  duplicateRole: (id: string) => string | null

  createPermission: (input: { name: string; description: string }) => void
  updatePermission: (id: string, patch: Partial<Pick<Permission, 'name' | 'description'>>) => void
  deletePermission: (id: string) => void

  addUser: (username: string) => string
  removeUser: (id: string) => void
  setUserRoles: (id: string, role_ids: string[]) => void
  revokeRoleFromUser: (userId: string, roleId: string) => void
}

export const RbacDataCtx = createContext<RbacData | null>(null)
export const RbacActionsCtx = createContext<RbacActions | null>(null)
