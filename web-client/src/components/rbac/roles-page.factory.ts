import type { SeedSpec } from '@/mocks/rbac-engine'

/**
 * A deterministic RBAC universe for the Roles page: **one default role and one
 * plain one**, so every assertion has its negative twin. A suite seeded with
 * only the default role would pass against a page that badges (and locks down)
 * every role indiscriminately.
 *
 * The engine sorts roles by name, so `Owner` sorts ahead of `User` and is the
 * role the page selects on first paint.
 */
export const PERM_VIEW = 'p_view'
export const PERM_CREATE = 'p_create'
export const DEFAULT_ROLE_ID = 'r_default'
export const PLAIN_ROLE_ID = 'r_plain'

export function buildRolesSeed(overrides: SeedSpec = {}): SeedSpec {
  return {
    permissions: [
      { id: PERM_VIEW, name: 'tournament.view', description: 'See tournaments.' },
      { id: PERM_CREATE, name: 'tournament.create', description: 'Spin up a tournament.' },
    ],
    roles: [
      {
        id: DEFAULT_ROLE_ID,
        name: 'User',
        description: 'Held by every user. Carries no permissions by default.',
        permission_ids: [],
        is_default: true,
      },
      {
        id: PLAIN_ROLE_ID,
        name: 'Owner',
        description: 'Full control of the workspace.',
        permission_ids: [PERM_VIEW, PERM_CREATE],
        is_default: false,
      },
    ],
    users: [
      // Every user holds the default role (ADR-0016) — including this one, who
      // also happens to be an owner.
      { id: 'u1', username: 'tim.nguyen', role_ids: [DEFAULT_ROLE_ID, PLAIN_ROLE_ID] },
      { id: 'u2', username: 'eun.han', role_ids: [DEFAULT_ROLE_ID] },
    ],
    ...overrides,
  }
}
