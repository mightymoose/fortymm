/**
 * Server-defined permission names. Mirror api/scripts/seed_rbac.py — typos
 * silently fail-open since both producer (FastAPI) and consumer (nav gating)
 * compare on the string. Keep this enum the source of truth client-side.
 */
export const PERM = {
  ADMIN_VIEW: 'administration.view',
  AUTH_MANAGE: 'authorization.manage',
  // Tournament creation is the one permission-gated tournament capability.
  // Viewing a published tournament and entering one of its events need no
  // permission (#1092 deleted `tournament.view`/`tournament.enter`) — every
  // signed-in user can, and self-entry is bounded server-side by a per-IP rate
  // limit instead. Editing, deleting, and publishing a tournament are owner-only
  // on the server (the creator), driven by the `canEdit` flag on the tournament
  // payload — there is intentionally no edit/delete/publish perm.
  TOURNAMENT_CREATE: 'tournament.create',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
  // Gates the Administration area's schedule-solve ledger page — its own grant
  // (like notifications.broadcast) so an operator can hand out ledger read
  // access without also handing out the RBAC-management keys. Mirrors
  // api/app/admin_schedule_solves.py:SCHEDULING_VIEW_PERMISSION.
  SCHEDULING_VIEW: 'scheduling.view',
  // Gates agent access to the MCP server on the user's behalf. Its own grant,
  // like the other feature-scoped perms above, so an operator can hand out
  // agent access without the RBAC-management keys. Mirrors the `mcp.access`
  // permission the server enforces on the MCP transport.
  MCP_ACCESS: 'mcp.access',
} as const

export type PermissionName = (typeof PERM)[keyof typeof PERM]
