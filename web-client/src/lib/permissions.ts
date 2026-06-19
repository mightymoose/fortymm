/**
 * Server-defined permission names. Mirror api/scripts/seed_rbac.py — typos
 * silently fail-open since both producer (FastAPI) and consumer (nav gating)
 * compare on the string. Keep this enum the source of truth client-side.
 */
export const PERM = {
  ADMIN_VIEW: 'administration.view',
  AUTH_MANAGE: 'authorization.manage',
  // Tournaments split: viewing the area and creating tournaments are the only
  // permission grants. Editing, deleting, and publishing a tournament are
  // owner-only on the server (the creator), driven by the `canEdit` flag on the
  // tournament payload — there is intentionally no edit/delete/publish perm.
  TOURNAMENT_VIEW: 'tournament.view',
  TOURNAMENT_CREATE: 'tournament.create',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
} as const

export type PermissionName = (typeof PERM)[keyof typeof PERM]
