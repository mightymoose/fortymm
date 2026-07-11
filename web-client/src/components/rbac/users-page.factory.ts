import type { SeedSpec } from '@/mocks/rbac-engine'

/**
 * A deterministic RBAC universe for the Users page: **one default role and one
 * plain one**, so every assertion about the locked default checkbox has its
 * negative twin in the still-toggleable plain role. A suite seeded with only
 * the default role would pass against a page that disabled *every* checkbox.
 *
 * The seeded user holds only the default role, leaving the plain role free to
 * be ticked on (and saved) by a test.
 */
export const DEFAULT_ROLE_ID = 'r_default'
export const PLAIN_ROLE_ID = 'r_plain'
export const USER_ID = 'u_eun'

export function buildUsersSeed(overrides: SeedSpec = {}): SeedSpec {
  return {
    permissions: [
      { id: 'p_view', name: 'tournament.view', description: 'See tournaments.' },
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
        permission_ids: ['p_view'],
        is_default: false,
      },
    ],
    users: [
      // Holds only the default role (ADR-0016) — so Owner is free to toggle on.
      { id: USER_ID, username: 'eun.han', role_ids: [DEFAULT_ROLE_ID] },
    ],
    ...overrides,
  }
}
