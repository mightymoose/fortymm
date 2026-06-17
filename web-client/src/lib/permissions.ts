/**
 * Server-defined permission names. Mirror api/scripts/seed_rbac.py — typos
 * silently fail-open since both producer (FastAPI) and consumer (nav gating)
 * compare on the string. Keep this enum the source of truth client-side.
 */
export const PERM = {
  ADMIN_VIEW: 'administration.view',
  AUTH_MANAGE: 'authorization.manage',
  TOURNAMENT_MANAGE: 'tournament.manage',
} as const

export type PermissionName = (typeof PERM)[keyof typeof PERM]
