import type { PermissionsSummaryProps } from './permissions-summary'

/** Props for `PermissionsSummary` — the dev world's signed-in player. */
export function buildPermissionsSummaryProps(
  overrides: Partial<PermissionsSummaryProps> = {},
): PermissionsSummaryProps {
  return { username: 'rita.kovac', ...overrides }
}
