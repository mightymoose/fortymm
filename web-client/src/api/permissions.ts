import type { components } from './schema'

// The built-in permissions: the keys the code checks. The session's account
// lists the keys its roles grant, custom ones included.
export const Permission = {
  adminView: 'admin.view',
  rolesManage: 'roles.manage',
  accountRolesManage: 'account_roles.manage',
  signingKeysRevoke: 'signing_keys.revoke',
  matchesCreate: 'matches.create',
} as const

export type BuiltInPermission = (typeof Permission)[keyof typeof Permission]

// Whether the session's account holds `permission`. The page only hides what
// the account can't do. The API checks every request again.
export function can(
  account: components['schemas']['SessionAccount'],
  permission: BuiltInPermission,
): boolean {
  return account.permissions.includes(permission)
}
