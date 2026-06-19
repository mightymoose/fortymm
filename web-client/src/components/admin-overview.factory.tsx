import { PERM } from '@/lib/permissions'

/** The permissions an admin who can see the Overview carries — the default
 * "authorized" scenario for the gate. */
export function buildAdminPermissions(overrides: string[] = []): string[] {
  return [PERM.ADMIN_VIEW, ...overrides]
}
