/**
 * Server-defined permission names. Mirror api/scripts/seed_rbac.py — typos
 * silently fail-open since both producer (FastAPI) and consumer (nav gating)
 * compare on the string. Keep this enum the source of truth client-side.
 */
export const PERM = {
  ADMIN_VIEW: 'administration.view',
  AUTH_MANAGE: 'authorization.manage',
  // Tournaments split: viewing the area, creating tournaments, and entering an
  // event as a player are the permission grants. Editing, deleting, and
  // publishing a tournament are owner-only on the server (the creator), driven
  // by the `canEdit` flag on the tournament payload — there is intentionally no
  // edit/delete/publish perm.
  //
  // TOURNAMENT_ENTER is the odd one out: it gates a *non-owner* mutation (a
  // player self-registering into someone else's tournament), so it can't ride on
  // `canEdit`. See ADR-0016.
  TOURNAMENT_VIEW: 'tournament.view',
  TOURNAMENT_CREATE: 'tournament.create',
  TOURNAMENT_ENTER: 'tournament.enter',
  NOTIFICATIONS_BROADCAST: 'notifications.broadcast',
  // Gates the Administration area's schedule-solve ledger page — its own grant
  // (like notifications.broadcast) so an operator can hand out ledger read
  // access without also handing out the RBAC-management keys. Mirrors
  // api/app/admin_schedule_solves.py:SCHEDULING_VIEW_PERMISSION.
  SCHEDULING_VIEW: 'scheduling.view',
  // Gates the Administration area's API-token page — its own grant (like
  // notifications.broadcast / scheduling.view) so an operator can hand out the
  // ability to mint a personal opaque bearer token without also handing out the
  // RBAC-management keys. Mirrors the server's `api_token.manage` permission,
  // which fronts `POST /v1/api-tokens`.
  API_TOKEN_MANAGE: 'api_token.manage',
  // Gates the Settings page's **Agent access** section — the Auth0 identity link
  // that lets an AI agent reach the MCP server on the user's behalf. Its own
  // grant, like the other feature-scoped perms above, so an operator can hand out
  // agent access without the RBAC-management keys. Mirrors the `mcp.access`
  // permission the server enforces on the `/v1/auth0/link*` endpoints.
  MCP_ACCESS: 'mcp.access',
} as const

export type PermissionName = (typeof PERM)[keyof typeof PERM]
