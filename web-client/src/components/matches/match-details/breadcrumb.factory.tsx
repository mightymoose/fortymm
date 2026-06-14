import type { BreadcrumbProps } from './breadcrumb'

/** Props for `Breadcrumb`. */
export function buildBreadcrumbProps(
  overrides: Partial<BreadcrumbProps> = {},
): BreadcrumbProps {
  return {
    matchId: 'abcdef0000',
    ...overrides,
  }
}
