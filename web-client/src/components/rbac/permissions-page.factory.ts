import type { SeedSpec } from '@/mocks/rbac-engine'

/**
 * A deterministic RBAC universe for the Permissions page.
 *
 * Two permissions share the `tournament` prefix so the page's grouping has
 * something to group, and one carries an **accented description**. The name is
 * ASCII by pattern (`PERMISSION_NAME_PATTERN`), so the description is the only
 * field on this page where a diacritic can appear — a fixture with only ASCII
 * descriptions cannot fail against accent-sensitive matching.
 */
export const PERM_VIEW_ID = 'p_view'
export const PERM_CREATE_ID = 'p_create'
export const PERM_CAFE_ID = 'p_cafe'

/** The accented description, and the ASCII text that must find it. */
export const CAFE_DESCRIPTION = 'Run the tournament café counter.'
export const CAFE_PERMISSION_NAME = 'venue.catering'

export function buildPermissionsSeed(overrides: SeedSpec = {}): SeedSpec {
  return {
    permissions: [
      { id: PERM_VIEW_ID, name: 'tournament.view', description: 'See tournaments.' },
      { id: PERM_CREATE_ID, name: 'tournament.create', description: 'Spin up a tournament.' },
      { id: PERM_CAFE_ID, name: CAFE_PERMISSION_NAME, description: CAFE_DESCRIPTION },
    ],
    roles: [
      {
        id: 'r_default',
        name: 'User',
        description: 'Held by every user. Carries no permissions by default.',
        permission_ids: [],
        is_default: true,
      },
      {
        id: 'r_owner',
        name: 'Owner',
        description: 'Full control of the workspace.',
        permission_ids: [PERM_VIEW_ID, PERM_CREATE_ID],
        is_default: false,
      },
    ],
    users: [{ id: 'u_eun', username: 'eun.han', role_ids: ['r_default'] }],
    ...overrides,
  }
}
